# WA Central API

API central para coordenar contatos, reservas e relatorios entre varios PCs do WA Disparador.

## Variaveis

```text
PORT=3333
API_KEY=troque-por-uma-chave-forte
DATABASE_URL=postgresql://wa_user:SENHA@postgres:5432/wa_central
RESERVATION_MINUTES=60
TZ=America/Sao_Paulo
```

## Endpoints

Todos os endpoints, exceto `/health`, exigem:

```http
X-API-Key: sua-chave
```

### GET /health

Verifica se a API e o banco estao respondendo.

### GET /contacts/summary

Resumo:

```json
{
  "total": 0,
  "pending": 0,
  "reserved": 0,
  "sent": 0,
  "failed": 0,
  "sent_today": 0
}
```

### POST /contacts/import

```json
{
  "contacts": "5511999999999\n5531999999999",
  "source": "painel"
}
```

### POST /contacts/reserve

Reserva contatos para um PC/worker.

```json
{
  "quantity": 100,
  "workerId": "pc-1",
  "reservationMinutes": 60
}
```

### POST /contacts/release

Libera reservas de um worker.

```json
{
  "workerId": "pc-1"
}
```

### POST /contacts/mark-sent

Marca contatos como enviados manualmente.

```json
{
  "contacts": "5511999999999\n5531999999999"
}
```

### POST /sends

Registra envio/falha e atualiza o status do contato.

```json
{
  "contactId": 1,
  "batchId": "BATCH-123",
  "workerId": "pc-1",
  "sessionId": 0,
  "senderPhone": "5511999999999",
  "destinationPhone": "5531999999999",
  "status": "SENT",
  "reason": "",
  "details": "Enviado com sucesso",
  "messagePreview": "Ola..."
}
```

### GET /report

Lista relatorio em JSON.

### GET /report/csv

Baixa relatorio em CSV.
