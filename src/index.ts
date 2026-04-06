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

// --- OAuth2 JWT Auth ---

let accessToken: string | null = null;

async function authenticate(): Promise<string> {
  const response = await fetch(`${API_URL}/authcontroller_gettoken_v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Authentication failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { token?: string; accessToken?: string };
  const token = data.token || data.accessToken;
  if (!token) {
    throw new Error(
      `Authentication response missing token: ${JSON.stringify(data)}`
    );
  }

  accessToken = token;
  return token;
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
      "Create a tax-compliant invoice in Billin. Supports Spanish tax codes (IVA_21, IVA_10, IVA_4, etc.) and Verifactu compliance. Provide line items with tax classification and a contact (existing or inline).",
    inputSchema: {
      serialCode: z
        .string()
        .optional()
        .describe("Custom serial code for the invoice (e.g. F2026001). Auto-generated if omitted"),
      currency: z
        .string()
        .default("EUR")
        .describe("ISO 4217 currency code (default: EUR)"),
      issuedDate: z
        .string()
        .optional()
        .describe("Invoice issue date in ISO 8601 format (e.g. 2026-04-06). Defaults to today"),
      dueDate: z
        .string()
        .optional()
        .describe("Payment due date in ISO 8601 format"),
      lines: z
        .array(
          z.object({
            name: z.string().describe("Item description"),
            quantity: z.number().default(1).describe("Quantity"),
            unitPrice: z.number().describe("Unit price before tax"),
            taxKey: z
              .string()
              .default("IVA_21")
              .describe("Tax code: IVA_21, IVA_10, IVA_4, IVA_0, IRPF_15, IRPF_7, RE_52, RE_14, RE_01"),
          })
        )
        .describe("Line items for the invoice"),
      contact: z
        .object({
          fiscalName: z.string().describe("Legal/fiscal name of the client"),
          vatNumber: z
            .string()
            .optional()
            .describe("Tax ID / NIF / CIF / VAT number"),
          email: z.string().optional().describe("Contact email"),
          address: z
            .object({
              country: z.string().default("ES").describe("ISO country code"),
              province: z
                .string()
                .optional()
                .describe("Province (required for Spain)"),
              city: z.string().optional().describe("City"),
              street: z.string().optional().describe("Street address"),
              postalCode: z.string().optional().describe("Postal code"),
            })
            .optional()
            .describe("Contact address"),
        })
        .describe("Invoice recipient — provide fiscal name at minimum"),
      reference: z.string().optional().describe("Internal reference or PO number"),
      comments: z.string().optional().describe("Notes to appear on the invoice"),
    },
  },
  async (params) => {
    const result = await billinFetch("/invoices", {
      method: "POST",
      body: JSON.stringify(params),
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
      "List and filter invoices from your Billin account. Filter by document type, status, payment status, date range, VAT number, or Verifactu invoices.",
    inputSchema: {
      documentType: z
        .enum(["INVOICE", "CORRECTIVE", "TEST_INVOICE"])
        .optional()
        .describe("Filter by document type"),
      status: z
        .enum(["DRAFT", "ISSUED", "VOID", "CORRECTED", "REPLACED"])
        .optional()
        .describe("Filter by invoice status"),
      isPaid: z
        .boolean()
        .optional()
        .describe("Filter by payment status"),
      issuedDateFrom: z
        .string()
        .optional()
        .describe("Filter invoices issued on or after this date (YYYY-MM-DD)"),
      issuedDateTo: z
        .string()
        .optional()
        .describe("Filter invoices issued on or before this date (YYYY-MM-DD)"),
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
        .describe("Field to sort by"),
      sortOrder: z
        .enum(["ASC", "DESC"])
        .optional()
        .describe("Sort direction"),
      limit: z
        .number()
        .optional()
        .describe("Max results to return (1-100, default 10)"),
      offset: z
        .number()
        .optional()
        .describe("Number of results to skip for pagination"),
    },
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.documentType) query.set("query[documentType]", params.documentType);
    if (params.status) query.set("query[status]", params.status);
    if (params.isPaid !== undefined) query.set("query[isPaid]", String(params.isPaid));
    if (params.issuedDateFrom) query.set("query[issuedDate][$gte]", params.issuedDateFrom);
    if (params.issuedDateTo) query.set("query[issuedDate][$lte]", params.issuedDateTo);
    if (params.vatNumber) query.set("query[contact][vatNumber]", params.vatNumber);
    if (params.verifactuOnly) query.set("query[getVerifactuInvoices]", "true");
    if (params.sortBy) query.set(`sort[${params.sortBy}]`, params.sortOrder || "DESC");
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
      "Get the full details of a specific invoice by its ID. Returns line items, tax breakdown, contact info, payment status, and Verifactu data.",
    inputSchema: {
      id: z.string().describe("Invoice ID"),
    },
  },
  async (params) => {
    const result = await billinFetch(`/invoices/${encodeURIComponent(params.id)}`);
    return formatResult(result);
  }
);

// Tool 4: Create Receipt
server.registerTool(
  "create_receipt",
  {
    title: "Create Receipt",
    description:
      "Create a simplified sales receipt (ticket) in Billin. Used for point-of-sale transactions where a full invoice is not required.",
    inputSchema: {
      currency: z.string().default("EUR").describe("Currency code (default: EUR)"),
      issuedDate: z
        .string()
        .optional()
        .describe("Issue date in ISO 8601 format"),
      lines: z
        .array(
          z.object({
            name: z.string().describe("Item description"),
            quantity: z.number().default(1).describe("Quantity"),
            unitPrice: z.number().describe("Unit price before tax"),
            taxKey: z
              .string()
              .default("IVA_21")
              .describe("Tax code (e.g. IVA_21, IVA_10, IVA_4)"),
          })
        )
        .describe("Line items"),
      contact: z
        .object({
          fiscalName: z.string().describe("Client name"),
          vatNumber: z.string().optional().describe("Tax ID / NIF"),
        })
        .optional()
        .describe("Optional contact info"),
      comments: z.string().optional().describe("Notes"),
    },
  },
  async (params) => {
    const result = await billinFetch("/receipts", {
      method: "POST",
      body: JSON.stringify(params),
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
      "Create a new contact (customer or supplier) in Billin. Contacts can be referenced when creating invoices, expenses, or quotes.",
    inputSchema: {
      fiscalName: z.string().describe("Legal/fiscal name"),
      vatNumber: z.string().optional().describe("Tax ID / NIF / CIF / VAT number"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      isCustomer: z
        .boolean()
        .optional()
        .describe("Mark as customer (default: true)"),
      isProvider: z
        .boolean()
        .optional()
        .describe("Mark as supplier/provider"),
      address: z
        .object({
          country: z.string().default("ES").describe("ISO country code"),
          province: z.string().optional().describe("Province (required for Spain)"),
          city: z.string().optional().describe("City"),
          street: z.string().optional().describe("Street address"),
          postalCode: z.string().optional().describe("Postal code"),
        })
        .optional()
        .describe("Contact address"),
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
    description:
      "List and search contacts in your Billin account. Filter by VAT number, customer/supplier type.",
    inputSchema: {
      vatNumber: z.string().optional().describe("Filter by exact VAT/NIF number"),
      isCustomer: z.boolean().optional().describe("Filter by customer flag"),
      isProvider: z.boolean().optional().describe("Filter by supplier flag"),
      sortBy: z
        .enum(["fiscalName", "vatNumber", "updatedAt", "createdAt"])
        .optional()
        .describe("Field to sort by"),
      sortOrder: z.enum(["ASC", "DESC"]).optional().describe("Sort direction"),
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Results to skip for pagination"),
    },
  },
  async (params) => {
    const query = new URLSearchParams();
    if (params.vatNumber) query.set("query[vatNumber]", params.vatNumber);
    if (params.isCustomer !== undefined) query.set("query[isCustomer]", String(params.isCustomer));
    if (params.isProvider !== undefined) query.set("query[isProvider]", String(params.isProvider));
    if (params.sortBy) query.set(`sort[${params.sortBy}]`, params.sortOrder || "ASC");
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
      "Record a business expense in Billin. Used for tracking purchases, supplier invoices, and deductible costs with proper tax classification.",
    inputSchema: {
      identifier: z.string().describe("Expense identifier (supplier invoice number)"),
      issuedDate: z.string().describe("Issue date in ISO 8601 format (YYYY-MM-DD)"),
      currency: z.string().default("EUR").describe("Currency code (default: EUR)"),
      lines: z
        .array(
          z.object({
            name: z.string().describe("Expense description"),
            subtotal: z.number().describe("Amount before tax"),
            totalAmount: z.number().describe("Amount including tax"),
            taxKey: z
              .string()
              .default("IVA_21")
              .describe("Tax code (e.g. IVA_21, IVA_10, IVA_4)"),
            taxAmount: z.number().describe("Tax amount"),
          })
        )
        .describe("Expense line items"),
      contact: z
        .object({
          fiscalName: z.string().describe("Supplier fiscal name"),
          vatNumber: z.string().optional().describe("Supplier tax ID / NIF / CIF"),
          address: z
            .object({
              country: z.string().default("ES").describe("ISO country code"),
              province: z.string().optional().describe("Province"),
            })
            .optional()
            .describe("Supplier address"),
        })
        .describe("Supplier contact"),
      comments: z.string().optional().describe("Notes"),
    },
  },
  async (params) => {
    const result = await billinFetch("/expenses", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return formatResult(result);
  }
);

// Tool 8: List Expenses
server.registerTool(
  "list_expenses",
  {
    title: "List Expenses",
    description:
      "List expenses from your Billin account. Useful for reviewing business costs and tax-deductible purchases.",
    inputSchema: {
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Results to skip for pagination"),
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
      "Create a quote (presupuesto) in Billin. Quotes can be sent to clients and later converted into invoices.",
    inputSchema: {
      currency: z.string().default("EUR").describe("Currency code (default: EUR)"),
      issuedDate: z
        .string()
        .optional()
        .describe("Quote date in ISO 8601 format"),
      validUntil: z
        .string()
        .optional()
        .describe("Expiration date in ISO 8601 format"),
      lines: z
        .array(
          z.object({
            name: z.string().describe("Item description"),
            quantity: z.number().default(1).describe("Quantity"),
            unitPrice: z.number().describe("Unit price before tax"),
            taxKey: z
              .string()
              .default("IVA_21")
              .describe("Tax code (e.g. IVA_21, IVA_10, IVA_4)"),
          })
        )
        .describe("Line items"),
      contact: z
        .object({
          fiscalName: z.string().describe("Client fiscal name"),
          vatNumber: z.string().optional().describe("Tax ID / NIF / CIF"),
          email: z.string().optional().describe("Client email"),
          address: z
            .object({
              country: z.string().default("ES").describe("ISO country code"),
              province: z.string().optional().describe("Province"),
              city: z.string().optional().describe("City"),
              street: z.string().optional().describe("Street"),
              postalCode: z.string().optional().describe("Postal code"),
            })
            .optional()
            .describe("Client address"),
        })
        .describe("Quote recipient"),
      reference: z.string().optional().describe("Internal reference"),
      comments: z.string().optional().describe("Notes for the client"),
    },
  },
  async (params) => {
    const result = await billinFetch("/quotes", {
      method: "POST",
      body: JSON.stringify(params),
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
      "Record a payment for an invoice in Billin. Links a payment amount to an existing invoice to track collection status.",
    inputSchema: {
      invoiceId: z.string().describe("ID of the invoice being paid"),
      amount: z.number().describe("Payment amount"),
      currency: z.string().default("EUR").describe("Currency code (default: EUR)"),
      paymentDate: z
        .string()
        .optional()
        .describe("Payment date in ISO 8601 format (defaults to today)"),
      paymentMethod: z
        .string()
        .optional()
        .describe("Payment method (e.g. transfer, cash, card)"),
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
    description:
      "List payments recorded in your Billin account. Useful for reconciliation and tracking outstanding balances.",
    inputSchema: {
      limit: z.number().optional().describe("Max results (1-100, default 10)"),
      offset: z.number().optional().describe("Results to skip for pagination"),
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
