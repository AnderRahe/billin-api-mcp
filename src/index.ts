#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Configuration ---

const CLIENT_ID = process.env.BILLIN_CLIENT_ID;
const CLIENT_SECRET = process.env.BILLIN_CLIENT_SECRET;
const API_URL = process.env.BILLIN_API_URL || "https://api.billin.net/v1";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing environment variables. Set BILLIN_CLIENT_ID and BILLIN_CLIENT_SECRET."
  );
  process.exit(1);
}

// Validate API URL
const parsedUrl = new URL(API_URL);
if (!parsedUrl.hostname.endsWith("billin.net")) {
  console.error("BILLIN_API_URL must point to a *.billin.net domain.");
  process.exit(1);
}

// --- Tax Rate Lookup ---

const TAX_RATES: Record<string, number> = {
  IVA_21: 0.21,
  IVA_10: 0.10,
  IVA_4: 0.04,
  IVA_0: 0,
};

const SALES_EQ_RATES: Record<string, number> = {
  RE_52: 0.052,
  RE_14: 0.014,
  RE_01: 0.005,
};

function computeLine(line: {
  name: string;
  quantity: number;
  unitPrice: number;
  taxKey: string;
  discountPercentage?: number;
}) {
  const subtotal = +(line.quantity * line.unitPrice).toFixed(2);
  const discountPercentage = line.discountPercentage ?? 0;
  const discountAmount = +(subtotal * discountPercentage / 100).toFixed(2);
  const taxBase = subtotal - discountAmount;
  const taxRate = TAX_RATES[line.taxKey] ?? 0;
  const taxAmount = +(taxBase * taxRate).toFixed(2);
  const salesEqRate = SALES_EQ_RATES[line.taxKey] ?? 0;
  const salesEqTaxAmount = +(taxBase * salesEqRate).toFixed(2);
  const totalAmount = +(taxBase + taxAmount + salesEqTaxAmount).toFixed(2);

  return {
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxKey: line.taxKey,
    discountPercentage,
    discountAmount,
    taxAmount,
    salesEqTaxAmount,
    totalAmount,
  };
}

// --- OAuth2 JWT Auth ---

let accessToken: string | null = null;

async function authenticate(): Promise<string> {
  const response = await fetch(`${API_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "client_credentials",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Authentication failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    accessToken?: string;
    refreshToken?: string;
    expireIn?: number;
  };
  if (!data.accessToken) {
    throw new Error(
      `Authentication response missing token: ${JSON.stringify(data)}`
    );
  }

  accessToken = data.accessToken;
  return accessToken;
}

// --- API Fetch Wrapper ---

async function billinFetch(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!accessToken) {
    await authenticate();
  }

  const doRequest = async (): Promise<Response> => {
    const url = `${API_URL}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...((options.headers as Record<string, string>) ?? {}),
      },
    });
  };

  let response = await doRequest();

  // Auto-renew token on 401
  if (response.status === 401) {
    await authenticate();
    response = await doRequest();
  }

  let data: unknown;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { ok: response.ok, status: response.status, data };
}

function formatResult(result: { ok: boolean; status: number; data: unknown }) {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error ${result.status}: ${JSON.stringify(result.data, null, 2)}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
    ],
  };
}

// --- Shared Zod Schemas ---

const addressSchema = z
  .object({
    country: z.string().default("ES").describe("ISO country code (default: ES)"),
    province: z
      .string()
      .optional()
      .describe(
        "ISO 3166-2:ES province code (required for Spain). Examples: ES-M (Madrid), ES-B (Barcelona), ES-V (Valencia), ES-SE (Sevilla), ES-BI (Vizcaya)"
      ),
    city: z
      .string()
      .optional()
      .describe("City (required for Spanish contacts)"),
    postalAddress: z
      .string()
      .optional()
      .describe("Street address (max 64 chars)"),
    postalCode: z
      .string()
      .optional()
      .describe("Postal code (required for Spanish contacts, max 20 chars)"),
  })
  .optional()
  .describe(
    "Address — province, city, and postalCode are required for Spanish contacts"
  );

const lineItemSchema = z.object({
  name: z.string().describe("Item description"),
  quantity: z.number().default(1).describe("Quantity"),
  unitPrice: z.number().describe("Unit price before tax"),
  taxKey: z
    .string()
    .default("IVA_21")
    .describe(
      "Tax code: IVA_21 (21%), IVA_10 (10%), IVA_4 (4%), IVA_0 (0%). Tax amounts are auto-calculated"
    ),
  discountPercentage: z
    .number()
    .optional()
    .describe("Discount percentage (0-100)"),
});

// --- Server ---

const server = new McpServer({
  name: "billin",
  version: "1.0.0",
});

// Tool 1: Create Invoice
server.registerTool(
  "create_invoice",
  {
    title: "Create Invoice",
    description:
      "Create a tax-compliant invoice in Billin with automatic tax calculation. Supports Spanish tax codes (IVA 21%, 10%, 4%, 0%) and Verifactu compliance. Just provide item name, quantity, unit price, and tax code — amounts are computed automatically.",
    inputSchema: {
      currency: z
        .string()
        .default("EUR")
        .describe("ISO 4217 currency code (default: EUR)"),
      issuedDate: z
        .string()
        .optional()
        .describe("Issue date YYYY-MM-DD (defaults to today)"),
      dueDate: z
        .string()
        .optional()
        .describe("Payment due date YYYY-MM-DD"),
      lines: z.array(lineItemSchema).describe("Invoice line items"),
      contact: z
        .object({
          fiscalName: z.string().describe("Legal/fiscal name of the client"),
          vatNumber: z
            .string()
            .optional()
            .describe("Tax ID / NIF / CIF / VAT number"),
          email: z.string().optional().describe("Contact email"),
          address: addressSchema,
        })
        .describe("Invoice recipient"),
      reference: z.string().optional().describe("Internal reference or PO number"),
      comments: z.string().optional().describe("Notes to appear on the invoice"),
    },
  },
  async (params) => {
    const body = {
      ...params,
      lines: params.lines.map(computeLine),
    };
    const result = await billinFetch("/invoices", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return formatResult(result);
  }
);

// Tool 2: List Invoices
server.registerTool(
  "list_invoices",
  {
    title: "List Invoices",
    description:
      "List and filter invoices. Filter by status, payment status, date range, VAT number, or Verifactu compliance.",
    inputSchema: {
      documentType: z
        .enum(["INVOICE", "CORRECTIVE", "TEST_INVOICE"])
        .optional()
        .describe("Filter by document type"),
      status: z
        .enum(["DRAFT", "ISSUED", "VOID", "CORRECTED", "REPLACED"])
        .optional()
        .describe("Filter by invoice status"),
      isPaid: z.boolean().optional().describe("Filter by payment status"),
      issuedDateFrom: z
        .string()
        .optional()
        .describe("Invoices issued on or after this date (YYYY-MM-DD)"),
      issuedDateTo: z
        .string()
        .optional()
        .describe("Invoices issued on or before this date (YYYY-MM-DD)"),
      vatNumber: z
        .string()
        .optional()
        .describe("Filter by customer VAT/NIF number"),
      verifactuOnly: z
        .boolean()
        .optional()
        .describe("Return only Verifactu-compliant invoices"),
      sortBy: z
        .enum(["issuedDate", "createdAt", "updatedAt", "serialCode", "code"])
        .optional()
        .describe("Sort field"),
      sortOrder: z.enum(["ASC", "DESC"]).optional().describe("Sort direction"),
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Skip N results for pagination"),
    },
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.documentType)
      query.set("query[documentType]", params.documentType);
    if (params.status) query.set("query[status]", params.status);
    if (params.isPaid !== undefined)
      query.set("query[isPaid]", String(params.isPaid));
    if (params.issuedDateFrom)
      query.set("query[issuedDate][$gte]", params.issuedDateFrom);
    if (params.issuedDateTo)
      query.set("query[issuedDate][$lte]", params.issuedDateTo);
    if (params.vatNumber)
      query.set("query[contact][vatNumber]", params.vatNumber);
    if (params.verifactuOnly)
      query.set("query[getVerifactuInvoices]", "true");
    if (params.sortBy)
      query.set(`sort[${params.sortBy}]`, params.sortOrder || "DESC");
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    const path = qs ? `/invoices?${qs}` : "/invoices";
    const result = await billinFetch(path);
    return formatResult(result);
  }
);

// Tool 3: Get Invoice
server.registerTool(
  "get_invoice",
  {
    title: "Get Invoice",
    description:
      "Get full details of a specific invoice by ID. Returns line items, tax breakdown, contact, payment status, and Verifactu data.",
    inputSchema: {
      id: z.string().describe("Invoice ID (UUID)"),
    },
  },
  async (params) => {
    const result = await billinFetch(
      `/invoices/${encodeURIComponent(params.id)}`
    );
    return formatResult(result);
  }
);

// Tool 4: Create Receipt
server.registerTool(
  "create_receipt",
  {
    title: "Create Receipt",
    description:
      "Create a simplified sales receipt (ticket) for point-of-sale transactions. Tax amounts are auto-calculated.",
    inputSchema: {
      currency: z.string().default("EUR").describe("Currency (default: EUR)"),
      issuedDate: z.string().optional().describe("Issue date YYYY-MM-DD"),
      lines: z.array(lineItemSchema).describe("Line items"),
      contact: z
        .object({
          fiscalName: z.string().describe("Client name"),
          vatNumber: z.string().optional().describe("Tax ID / NIF"),
          address: addressSchema,
        })
        .optional()
        .describe("Optional contact info"),
      comments: z.string().optional().describe("Notes"),
    },
  },
  async (params) => {
    const body = {
      ...params,
      lines: params.lines.map(computeLine),
    };
    const result = await billinFetch("/invoices/sales-receipts", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return formatResult(result);
  }
);

// Tool 5: Create Contact
server.registerTool(
  "create_contact",
  {
    title: "Create Contact",
    description:
      "Create a customer or supplier contact in Billin. Contacts can be referenced when creating invoices, expenses, or quotes.",
    inputSchema: {
      fiscalName: z.string().describe("Legal/fiscal name"),
      vatNumber: z
        .string()
        .optional()
        .describe("Tax ID / NIF / CIF / VAT number"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      isCustomer: z.boolean().optional().describe("Mark as customer (default: true)"),
      isProvider: z.boolean().optional().describe("Mark as supplier"),
      address: addressSchema,
    },
  },
  async (params) => {
    const result = await billinFetch("/contacts", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return formatResult(result);
  }
);

// Tool 6: List Contacts
server.registerTool(
  "list_contacts",
  {
    title: "List Contacts",
    description: "List and search contacts. Filter by VAT number or type.",
    inputSchema: {
      vatNumber: z.string().optional().describe("Filter by exact VAT/NIF"),
      isCustomer: z.boolean().optional().describe("Filter customers only"),
      isProvider: z.boolean().optional().describe("Filter suppliers only"),
      sortBy: z
        .enum(["fiscalName", "vatNumber", "updatedAt", "createdAt"])
        .optional()
        .describe("Sort field"),
      sortOrder: z.enum(["ASC", "DESC"]).optional().describe("Sort direction"),
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Skip N results"),
    },
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.vatNumber) query.set("query[vatNumber]", params.vatNumber);
    if (params.isCustomer !== undefined)
      query.set("query[isCustomer]", String(params.isCustomer));
    if (params.isProvider !== undefined)
      query.set("query[isProvider]", String(params.isProvider));
    if (params.sortBy)
      query.set(`sort[${params.sortBy}]`, params.sortOrder || "ASC");
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    const path = qs ? `/contacts?${qs}` : "/contacts";
    const result = await billinFetch(path);
    return formatResult(result);
  }
);

// Tool 7: Create Expense
server.registerTool(
  "create_expense",
  {
    title: "Create Expense",
    description:
      "Record a business expense with tax classification. Provide subtotal and tax key — tax amount is auto-calculated. Requires serialCode (e.g. 'GASTO') for numbering series.",
    inputSchema: {
      identifier: z
        .string()
        .describe("Supplier invoice number / expense identifier"),
      serialCode: z
        .string()
        .optional()
        .describe("Serial code for expense numbering series (e.g. 'GASTO'). Either serialCode or serieId is required."),
      serieId: z
        .string()
        .optional()
        .describe("Serie UUID. Takes priority over serialCode if both provided."),
      issuedDate: z.string().describe("Issue date YYYY-MM-DD"),
      currency: z.string().default("EUR").describe("Currency (default: EUR)"),
      lines: z
        .array(
          z.object({
            name: z.string().describe("Expense description"),
            subtotal: z.number().describe("Amount before tax"),
            taxKey: z
              .string()
              .default("IVA_21")
              .describe("Tax code (IVA_21, IVA_10, IVA_4, IVA_0)"),
          })
        )
        .describe("Expense line items — taxAmount and totalAmount are auto-calculated"),
      contact: z
        .object({
          fiscalName: z.string().describe("Supplier fiscal name"),
          vatNumber: z
            .string()
            .optional()
            .describe("Supplier tax ID / NIF / CIF"),
          address: addressSchema,
        })
        .describe("Supplier contact"),
      comments: z.string().optional().describe("Notes"),
    },
  },
  async (params) => {
    const body = {
      ...params,
      lines: params.lines.map((line) => {
        const taxRate = TAX_RATES[line.taxKey] ?? 0;
        const taxAmount = +(line.subtotal * taxRate).toFixed(2);
        const totalAmount = +(line.subtotal + taxAmount).toFixed(2);
        return {
          name: line.name,
          subtotal: line.subtotal,
          taxKey: line.taxKey,
          taxAmount,
          totalAmount,
        };
      }),
    };
    const result = await billinFetch("/expenses", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return formatResult(result);
  }
);

// Tool 8: List Expenses
server.registerTool(
  "list_expenses",
  {
    title: "List Expenses",
    description: "List recorded expenses for reviewing costs and deductions.",
    inputSchema: {
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Skip N results"),
    },
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    const path = qs ? `/expenses?${qs}` : "/expenses";
    const result = await billinFetch(path);
    return formatResult(result);
  }
);

// Tool 9: Create Quote
server.registerTool(
  "create_quote",
  {
    title: "Create Quote",
    description:
      "Create a quote (presupuesto) that can be sent to clients and later converted into an invoice. Tax amounts are auto-calculated. Requires either serieId or serialCode to assign a numbering series.",
    inputSchema: {
      currency: z.string().default("EUR").describe("Currency (default: EUR)"),
      serialCode: z
        .string()
        .optional()
        .describe(
          "Serial code for quote numbering series (e.g. 'PRES'). Either serialCode or serieId is required."
        ),
      serieId: z
        .string()
        .optional()
        .describe(
          "Serie UUID. Takes priority over serialCode if both provided."
        ),
      issuedDate: z.string().optional().describe("Quote date YYYY-MM-DD"),
      dueDate: z.string().optional().describe("Expiration / due date YYYY-MM-DD"),
      status: z
        .enum(["PENDING", "ACCEPTED", "REJECTED"])
        .optional()
        .describe("Quote status (default: PENDING)"),
      lines: z.array(lineItemSchema).describe("Line items"),
      contact: z
        .object({
          fiscalName: z.string().describe("Client fiscal name"),
          vatNumber: z.string().optional().describe("Tax ID / NIF / CIF"),
          email: z.string().optional().describe("Client email"),
          address: addressSchema,
        })
        .describe("Quote recipient"),
      reference: z.string().optional().describe("Internal reference"),
      comments: z.string().optional().describe("Notes for the client"),
    },
  },
  async (params) => {
    const { ...rest } = params;
    const body = {
      ...rest,
      lines: params.lines.map(computeLine),
    };
    const result = await billinFetch("/quotes", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return formatResult(result);
  }
);

// Tool 10: Create Payment
server.registerTool(
  "create_payment",
  {
    title: "Create Payment",
    description:
      "Record a payment (income or expense). Link it to a document via documentsIds or to a contact via contactId (mutually exclusive — provide one or neither).",
    inputSchema: {
      operationDate: z
        .string()
        .describe("Payment date in YYYY-MM-DD format (required)"),
      amount: z.number().describe("Payment amount (minimum 0.01)"),
      type: z
        .enum(["INCOME", "EXPENSE"])
        .describe(
          "INCOME = payment received, EXPENSE = payment made"
        ),
      method: z
        .enum([
          "CREDIT_CARD",
          "BIZUM",
          "CASH",
          "DIRECT_DEBIT",
          "PROMISSORY_NOTE",
          "TRANSFER",
          "OTHER",
          "CONFIRMING",
          "NOT_CONFIRMED",
        ])
        .optional()
        .describe("Payment method"),
      documentsIds: z
        .array(z.string())
        .optional()
        .describe(
          "Array with a single document/invoice UUID to link this payment to. Mutually exclusive with contactId."
        ),
      contactId: z
        .string()
        .optional()
        .describe(
          "Contact UUID to link this payment to. Mutually exclusive with documentsIds."
        ),
      accountingAccountId: z
        .string()
        .optional()
        .describe("Related accounting account UUID"),
      description: z
        .string()
        .optional()
        .describe("Payment description (max 250 chars)"),
    },
  },
  async (params) => {
    const result = await billinFetch("/payments", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return formatResult(result);
  }
);

// Tool 11: List Payments
server.registerTool(
  "list_payments",
  {
    title: "List Payments",
    description: "List recorded payments for reconciliation and balance tracking.",
    inputSchema: {
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Skip N results"),
    },
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    if (params.offset !== undefined) query.set("offset", String(params.offset));

    const qs = query.toString();
    const path = qs ? `/payments?${qs}` : "/payments";
    const result = await billinFetch(path);
    return formatResult(result);
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
