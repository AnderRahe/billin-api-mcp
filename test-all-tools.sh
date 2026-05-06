#!/bin/bash
# Test all 11 MCP tools against live Billin API
set -e

# Load credentials from .env if present (BILLIN_CLIENT_ID, BILLIN_CLIENT_SECRET)
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

if [ -z "${BILLIN_CLIENT_ID:-}" ] || [ -z "${BILLIN_CLIENT_SECRET:-}" ]; then
  echo "ERROR: BILLIN_CLIENT_ID and BILLIN_CLIENT_SECRET must be set (export them or put them in .env)" >&2
  exit 1
fi

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
NOTIF='{"jsonrpc":"2.0","id":2,"method":"notifications/initialized"}'

call_tool() {
  local name="$1"
  local args="$2"
  local id="$3"
  local msg="{\"jsonrpc\":\"2.0\",\"id\":${id},\"method\":\"tools/call\",\"params\":{\"name\":\"${name}\",\"arguments\":${args}}}"
  printf '%s\n%s\n%s\n' "$INIT" "$NOTIF" "$msg" | node dist/index.js 2>/dev/null | tail -1
}

echo "========================================="
echo "BILLIN MCP SERVER — FULL TEST SUITE"
echo "========================================="

# 1. create_contact
echo ""
echo "--- TEST 1: create_contact ---"
RESULT=$(call_tool "create_contact" '{"fiscalName":"Test Contact MCP v2","vatNumber":"A22222222","email":"mcp2@test.es","isCustomer":true,"address":{"country":"ES","province":"ES-V","postalAddress":"Calle Test 2","postalCode":"46002","city":"Valencia"}}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d.get(\"fiscalName\",\"?\")} (ID: {d.get(\"id\",\"?\")})') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 2. list_contacts
echo ""
echo "--- TEST 2: list_contacts ---"
RESULT=$(call_tool "list_contacts" '{"limit":5}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d[\"count\"]} contacts found') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 3. create_invoice
echo ""
echo "--- TEST 3: create_invoice ---"
RESULT=$(call_tool "create_invoice" '{"currency":"EUR","lines":[{"name":"Servicio de testing MCP","quantity":2,"unitPrice":100,"taxKey":"IVA_21"}],"contact":{"fiscalName":"MCP Test Client SL","vatNumber":"B99999999","address":{"country":"ES","province":"ES-M","postalAddress":"Gran Via 50","postalCode":"28013","city":"Madrid"}}}' 3)
INVOICE_ID=$(echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(d.get('id',''))" 2>/dev/null)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d.get(\"identifier\",\"?\")} — {d[\"total\"][\"subtotal\"]}€ + {d[\"taxLines\"][0][\"taxAmount\"]}€ IVA = {d[\"total\"][\"totalAmount\"]}€') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 4. list_invoices
echo ""
echo "--- TEST 4: list_invoices ---"
RESULT=$(call_tool "list_invoices" '{"limit":5,"sortBy":"createdAt","sortOrder":"DESC"}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d[\"count\"]} invoices found') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 5. get_invoice
echo ""
echo "--- TEST 5: get_invoice ---"
if [ -n "$INVOICE_ID" ]; then
  RESULT=$(call_tool "get_invoice" "{\"id\":\"${INVOICE_ID}\"}" 3)
  echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d.get(\"identifier\",\"?\")} — status: {d.get(\"status\",\"?\")}') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"
else
  echo "  SKIP: no invoice ID from previous test"
fi

# 6. create_receipt (endpoint: /invoices/sales-receipts)
echo ""
echo "--- TEST 6: create_receipt ---"
RESULT=$(call_tool "create_receipt" '{"currency":"EUR","lines":[{"name":"Café y tostada","quantity":1,"unitPrice":3.50,"taxKey":"IVA_10"}]}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d.get(\"identifier\",\"?\")} — {d[\"total\"][\"totalAmount\"]}€') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 7. create_expense (address must include postalCode + city for Spain)
echo ""
echo "--- TEST 7: create_expense ---"
RESULT=$(call_tool "create_expense" '{"identifier":"FACT-PROV-002","serialCode":"GASTO","issuedDate":"2026-04-07","currency":"EUR","lines":[{"name":"Material de oficina","subtotal":50,"taxKey":"IVA_21"}],"contact":{"fiscalName":"Papelería López","vatNumber":"12345678Z","address":{"country":"ES","province":"ES-M","postalAddress":"Calle Menor 5","postalCode":"28012","city":"Madrid"}}}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: expense created — {d.get(\"total\",{}).get(\"totalAmount\",\"?\")}€') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 8. list_expenses
echo ""
echo "--- TEST 8: list_expenses ---"
RESULT=$(call_tool "list_expenses" '{"limit":5}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d[\"count\"]} expenses found') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 9. create_quote (requires serialCode or serieId)
echo ""
echo "--- TEST 9: create_quote ---"
RESULT=$(call_tool "create_quote" '{"currency":"EUR","serialCode":"PRES","lines":[{"name":"Desarrollo app móvil","quantity":1,"unitPrice":5000,"taxKey":"IVA_21"}],"contact":{"fiscalName":"StartupXYZ SL","vatNumber":"B55555555","address":{"country":"ES","province":"ES-B","postalAddress":"Carrer Mallorca 200","postalCode":"08036","city":"Barcelona"}}}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: quote created — {d.get(\"total\",{}).get(\"totalAmount\",\"?\")}€') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

# 10. create_payment (new schema: operationDate, amount, type, method, documentsIds)
echo ""
echo "--- TEST 10: create_payment ---"
if [ -n "$INVOICE_ID" ]; then
  RESULT=$(call_tool "create_payment" "{\"operationDate\":\"2026-04-07\",\"amount\":242,\"type\":\"INCOME\",\"method\":\"TRANSFER\",\"documentsIds\":[\"${INVOICE_ID}\"]}" 3)
  echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: payment recorded') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"
else
  echo "  SKIP: no invoice ID"
fi

# 11. list_payments
echo ""
echo "--- TEST 11: list_payments ---"
RESULT=$(call_tool "list_payments" '{"limit":5}' 3)
echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); d=json.loads(r['result']['content'][0]['text']); print(f'  OK: {d[\"count\"]} payments found') if 'isError' not in r['result'] else print(f'  FAIL: {r[\"result\"][\"content\"][0][\"text\"][:200]}')" 2>/dev/null || echo "  PARSE ERROR"

echo ""
echo "========================================="
echo "TEST COMPLETE"
echo "========================================="
