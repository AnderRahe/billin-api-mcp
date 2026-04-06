# Billin MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects AI agents to **[Billin](https://billin.net)** — Spain's invoicing platform for freelancers and SMBs.

Create invoices, record expenses, manage contacts, and track payments — all from Claude, Cursor, or any MCP-compatible AI assistant. Fully compatible with **Verifactu** and Spanish tax regulations.

## Tools

| Tool | Description |
|------|-------------|
| `create_invoice` | Create a tax-compliant invoice with line items and Spanish tax codes (IVA, IRPF, RE) |
| `list_invoices` | List and filter invoices by status, date, payment status, VAT number, or Verifactu |
| `get_invoice` | Get full details of a specific invoice |
| `create_receipt` | Create a simplified sales receipt (ticket) |
| `create_contact` | Create a customer or supplier contact |
| `list_contacts` | Search and filter contacts |
| `create_expense` | Record a business expense with tax classification |
| `list_expenses` | List recorded expenses |
| `create_quote` | Create a quote (presupuesto) for a client |
| `create_payment` | Record a payment against an invoice |
| `list_payments` | List recorded payments |

## Quick Start

### 1. Get Billin API credentials

1. Log in to your [Billin](https://billin.net) account
2. Go to **Integraciones** > **API Publica**
3. Click **Generar credenciales** to get your `clientId` and `clientSecret`

### 2. Install and build

```bash
git clone https://github.com/AnderRahe/billin-api-mcp.git
cd billin-api-mcp
npm install
npm run build
```

### 3. Configure Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "billin": {
      "command": "node",
      "args": ["/path/to/billin-api-mcp/dist/index.js"],
      "env": {
        "BILLIN_CLIENT_ID": "your_client_id",
        "BILLIN_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

## Usage Examples

### Create an invoice

> "Crea una factura a nombre de Acme SL, NIF B12345678, por 3 horas de consultoría a 75 euros la hora con IVA 21%"

The AI agent will call `create_invoice` with the appropriate line items, tax code (IVA_21), and contact details.

### Check unpaid invoices

> "Muéstrame las facturas pendientes de cobro de este mes"

Uses `list_invoices` with `isPaid: false` and date filters.

### Record an expense

> "Registra un gasto de 150 euros en material de oficina del proveedor Papelería López, NIF 12345678A"

Calls `create_expense` with the supplier info and IVA_21 tax classification.

### Create a quote

> "Prepara un presupuesto para el rediseño web de la empresa TechCorp por 3.500 euros"

Uses `create_quote` with line items and contact details.

## Supported Tax Codes

| Code | Description | Rate |
|------|-------------|------|
| `IVA_21` | Standard VAT | 21% |
| `IVA_10` | Reduced VAT | 10% |
| `IVA_4` | Super-reduced VAT | 4% |
| `IVA_0` | Exempt VAT | 0% |
| `IRPF_15` | Standard IRPF withholding | -15% |
| `IRPF_7` | Reduced IRPF (new freelancers) | -7% |
| `RE_52` | Recargo de equivalencia (standard) | 5.2% |
| `RE_14` | Recargo de equivalencia (reduced) | 1.4% |
| `RE_01` | Recargo de equivalencia (super-reduced) | 0.5% |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BILLIN_CLIENT_ID` | Yes | — | OAuth2 client ID from Billin |
| `BILLIN_CLIENT_SECRET` | Yes | — | OAuth2 client secret from Billin |
| `BILLIN_API_URL` | No | `https://api.billin.net/v1` | API base URL |

## Development

```bash
npm run dev    # Watch mode (auto-recompile on changes)
npm run build  # Compile TypeScript
npm run start  # Run the server
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node ./dist/index.js
```

## About Verifactu

Starting January 2027, all Spanish businesses must use certified invoicing software under the **Verifactu** regulation (RD 1007/2023). Billin is Verifactu-compliant, and this MCP server exposes that capability to AI agents — enabling freelancers and businesses to create legally compliant invoices through natural language.

## License

MIT
