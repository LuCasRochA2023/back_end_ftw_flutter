import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { constants as cryptoConstants } from 'crypto';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
app.set('trust proxy', true); // importante p/ req.ip atrás de nginx/cloudflare
app.use(express.json({ limit: '1mb' }));
app.use(cors());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Aceita ambas as chaves (você usou nomes diferentes em lugares diferentes)
const MP_ACCESS_TOKEN =
  process.env.MERCADO_PAGO_ACCESS_TOKEN ||
  process.env.MERCADOPAGO_ACCESS_TOKEN ||
  '';
const MP_PUBLIC_KEY =
  process.env.MERCADO_PAGO_PUBLIC_KEY || process.env.MERCADOPAGO_PUBLIC_KEY || '';

const DEFAULT_STATEMENT_DESCRIPTOR = (
  process.env.STATEMENT_DESCRIPTOR ||
  process.env.MERCADO_PAGO_STATEMENT_DESCRIPTOR ||
  process.env.MERCADOPAGO_STATEMENT_DESCRIPTOR ||
  ''
).trim();

const MP_NOTIFICATION_URL = (
  process.env.MP_NOTIFICATION_URL ||
  process.env.NOTIFICATION_URL ||
  ''
).trim();

// Configuração da chave PIX (se você usa pixKey no MP, isso aqui não é usado pelo /v1/payments)
const PIX_KEY = process.env.PIX_KEY;
const PIX_KEY_TYPE = process.env.PIX_KEY_TYPE;

const SSL_ENABLED = (process.env.SSL_ENABLED ?? 'true').toLowerCase() !== 'false';
const SSL_AUTO_GENERATE =
  (process.env.SSL_AUTO_GENERATE ?? 'true').toLowerCase() !== 'false';
const SSL_CERT_PATH =
  process.env.SSL_CERT_PATH ||
  path.join(__dirname, 'certs', 'selfsigned.cert.pem');
const SSL_KEY_PATH =
  process.env.SSL_KEY_PATH || path.join(__dirname, 'certs', 'selfsigned.key.pem');
const SSL_COMMON_NAME = process.env.SSL_COMMON_NAME || 'localhost';
const SSL_VALIDITY_DAYS = Number.isNaN(parseInt(process.env.SSL_VALIDITY_DAYS || '', 10))
  ? 365
  : parseInt(process.env.SSL_VALIDITY_DAYS, 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SSL_SAN =
  process.env.SSL_SAN || `DNS:${SSL_COMMON_NAME},DNS:localhost,IP:127.0.0.1`;

function detectCardType(cardNumber) {
  const clean = String(cardNumber || '').replace(/\D/g, '');
  if (clean.length < 6) return 'master';

  const firstTwo = parseInt(clean.substring(0, 2), 10);
  const firstFour = parseInt(clean.substring(0, 4), 10);
  const firstSix = parseInt(clean.substring(0, 6), 10);

  // Visa
  if (clean.startsWith('4')) return 'visa';

  // Mastercard
  if (firstTwo >= 51 && firstTwo <= 55) return 'master';
  if (firstFour >= 2221 && firstFour <= 2720) return 'master';

  // Amex
  if (firstTwo === 34 || firstTwo === 37) return 'amex';

  // Elo (BINs 6 dígitos) — antes estava comparando com firstFour (bug)
  const eloBins = new Set([
    636368, 438935, 504175, 451416, 636297, 509048, 509067, 509049, 509069,
    509050, 509074, 509068, 509040, 509045, 509051, 509046, 509066, 509047,
    509042, 509052, 509043, 509064,
  ]);
  if (eloBins.has(firstSix)) return 'elo';

  // Hipercard
  if (firstSix === 606282) return 'hipercard';

  return 'master';
}

function loadSslCredentials() {
  const keyExists = fs.existsSync(SSL_KEY_PATH);
  const certExists = fs.existsSync(SSL_CERT_PATH);

  if (keyExists && certExists) {
    return {
      key: fs.readFileSync(SSL_KEY_PATH, 'utf8'),
      cert: fs.readFileSync(SSL_CERT_PATH, 'utf8'),
      source: 'existing-files',
    };
  }

  if (!SSL_AUTO_GENERATE) {
    throw new Error('Certificados SSL não encontrados e geração automática desabilitada.');
  }

  if (keyExists || certExists) {
    console.warn('Certificados SSL incompletos encontrados. Gerando novo par autoassinado.');
  }

  const certDir = path.dirname(SSL_CERT_PATH);
  const keyDir = path.dirname(SSL_KEY_PATH);
  fs.mkdirSync(certDir, { recursive: true });
  fs.mkdirSync(keyDir, { recursive: true });

  const subject = process.env.SSL_SUBJECT || `/CN=${SSL_COMMON_NAME}`;
  const baseArgs = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-keyout',
    SSL_KEY_PATH,
    '-out',
    SSL_CERT_PATH,
    '-subj',
    subject,
    '-days',
    String(SSL_VALIDITY_DAYS),
  ];

  try {
    execFileSync('openssl', [...baseArgs, '-addext', `subjectAltName=${SSL_SAN}`], {
      stdio: 'ignore',
    });
  } catch (error) {
    console.warn(
      'Falha ao incluir subjectAltName via OpenSSL. Tentando gerar certificado sem SAN explícito.'
    );
    execFileSync('openssl', baseArgs, { stdio: 'ignore' });
  }

  console.log(`Certificado SSL autoassinado gerado com OpenSSL em ${SSL_CERT_PATH}`);

  return {
    key: fs.readFileSync(SSL_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(SSL_CERT_PATH, 'utf8'),
    source: 'generated',
  };
}

function getMeliSessionId(req, bodyDeviceId) {
  const h =
    req.get('x-meli-session-id') ||
    req.get('x-meli-sessionid') ||
    req.get('X-meli-session-id') ||
    req.get('X-meli-sessionid');
  const b =
    bodyDeviceId ||
    req.body?.device_id ||
    req.body?.deviceId ||
    req.body?.device_session_id ||
    req.body?.deviceSessionId;
  return String(h || b || '').trim();
}

function getClientIp(req) {
  // trust proxy = true → req.ip já considera x-forwarded-for
  const ip = req.ip || '';
  return String(ip).trim();
}

function normalizeCpf(payer) {
  const cpfFromLegacy = payer?.cpf;
  const cpfFromIdentification = payer?.identification?.number;
  const cpf = String(cpfFromLegacy || cpfFromIdentification || '').replace(/\D/g, '');
  return cpf.length === 11 ? cpf : '';
}

function splitName(payer) {
  const first = String(payer?.firstName || payer?.first_name || '').trim();
  const last = String(payer?.lastName || payer?.last_name || '').trim();
  return { first, last };
}

function normalizePhone(payer) {
  const raw = payer?.phone;
  if (raw && typeof raw === 'object') {
    return {
      area_code: String(raw.area_code || raw.areaCode || '').replace(/\D/g, '') || undefined,
      number: String(raw.number || '').replace(/\D/g, '') || undefined,
    };
  }
  const clean = String(raw || '').replace(/\D/g, '');
  if (clean.length >= 10) {
    return { area_code: clean.substring(0, 2), number: clean.substring(2) };
  }
  return {};
}

function normalizeAddress(payer) {
  const a = payer?.address || {};
  const zip = String(a.zip_code || a.zipCode || '').replace(/\D/g, '');
  return {
    zip_code: zip || undefined,
    street_name: a.street_name || a.streetName || a.street || undefined,
    street_number: a.street_number || a.streetNumber || a.number || undefined,
    neighborhood: a.neighborhood || undefined,
    city: a.city || undefined,
    federal_unit: a.federal_unit || a.federalUnit || a.state || undefined,
  };
}

function toAdditionalInfoAddress(address) {
  // Mercado Pago é bem restritivo no additional_info.payer.address.
  // NÃO enviar city/neighborhood/federal_unit aqui (gera erro "name of parameters is wrong").
  const a = address || {};
  const minimal = {
    zip_code: a.zip_code || undefined,
    street_name: a.street_name || undefined,
    street_number: a.street_number || undefined,
  };
  if (!minimal.zip_code && !minimal.street_name && !minimal.street_number) return null;
  return minimal;
}

// Rota para testar configuração do Mercado Pago
app.get('/config-test', async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(400).json({
        status: 'error',
        message: 'MP access token ausente (MERCADOPAGO_ACCESS_TOKEN / MERCADO_PAGO_ACCESS_TOKEN).',
      });
    }

    const response = await axios.get('https://api.mercadopago.com/v1/payment_methods', {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });

    res.json({
      status: 'ok',
      message: 'Mercado Pago configurado corretamente',
      pixKey: PIX_KEY,
      pixKeyType: PIX_KEY_TYPE,
      payment_methods_count: Array.isArray(response.data) ? response.data.length : undefined,
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      message: 'Token do Mercado Pago inválido ou sem permissões',
      error: error.response?.data || error.message,
    });
  }
});

// Rota unificada para pagamento via Pix ou Cartão
app.post('/create-payment', async (req, res) => {
  const {
    amount,
    description,
    payer,
    cardToken,
    paymentMethod, // 'pix' | 'credit_card'
    // Não exija PAN: o app deve mandar token + paymentMethodId (bandeira) e opcionalmente BIN/last4
    cardNumber, // (compat legado) usado só para detectar bandeira localmente
    paymentMethodId, // ex: "master"
    installments,
    cardBin,
    cardLast4,
    items,
    categoryId,
    notificationUrl,
    deviceId,
    externalReference,
    statementDescriptor,
  } = req.body || {};

  if (!MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'MP access token ausente no servidor.' });
  }

  const cleanAmount = Number(amount);
  const cleanDesc = String(description || '').trim();

  const cpf = normalizeCpf(payer);
  const { first, last } = splitName(payer);
  const phone = normalizePhone(payer);
  const address = normalizeAddress(payer);

  // Obrigatórios mínimos (aceita payer.cpf OU payer.identification.number)
  if (!cleanAmount || !cleanDesc || !payer?.email || !cpf) {
    return res.status(400).json({
      error: 'Parâmetros obrigatórios ausentes.',
      required: ['amount', 'description', 'payer.email', 'payer.cpf OR payer.identification.number'],
    });
  }

  // Express faz lookup case-insensitive, mas aceitamos também header alternativo "Idempotency-Key"
  const idempotencyKey =
    req.get('x-idempotency-key') || req.get('idempotency-key') || uuidv4();
  const clientIp = getClientIp(req);
  const clientUserAgent = req.get('user-agent') || '';
  const resolvedDeviceId = getMeliSessionId(req, deviceId);

  const paymentData = {
    transaction_amount: cleanAmount,
    description: cleanDesc,
    external_reference: String(externalReference || '').trim() || uuidv4(),
    payer: {
      email: payer.email,
      first_name: first || undefined,
      last_name: last || undefined,
      identification: { type: 'CPF', number: cpf },
      ...(phone.area_code || phone.number ? { phone } : {}),
      ...(address.zip_code || address.street_name ? { address } : {}),
      // se tiver no seu app: payer.dateRegistered / payer.registrationDate
      ...(payer?.dateRegistered || payer?.registrationDate
        ? { date_registered: payer.dateRegistered || payer.registrationDate }
        : {}),
    },
    metadata: {
      integration: 'flutter_custom_screen',
      user_id: payer?.userId || payer?.user_id || 'unknown',
      client_ip: clientIp || undefined,
      client_user_agent: clientUserAgent || undefined,
    },
  };

  // Itens (additional_info.items) ajudam score
  const DEFAULT_ITEM_CATEGORY_ID = String(process.env.MP_DEFAULT_ITEM_CATEGORY_ID || '').trim();
  const fallbackCategoryId = String(categoryId || DEFAULT_ITEM_CATEGORY_ID || '').trim();

  const normalizeItems = () => {
    if (Array.isArray(items) && items.length > 0) {
      const normalized = items
        .map((it) => {
          const quantity =
            Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1;
          const unitPrice =
            Number.isFinite(Number(it.unit_price)) && Number(it.unit_price) > 0
              ? Number(it.unit_price)
              : cleanAmount;
          const category = String(it.category_id || it.categoryId || fallbackCategoryId || '').trim();
          return {
            id: it.id ? String(it.id) : undefined,
            title: it.title ? String(it.title) : cleanDesc,
            description: it.description ? String(it.description) : cleanDesc,
            category_id: category || undefined,
            quantity,
            unit_price: unitPrice,
          };
        })
        .filter((it) => Number(it.unit_price) > 0 && Number(it.quantity) > 0);
      if (normalized.length > 0) return normalized;
    }
    return [
      {
        title: cleanDesc,
        description: cleanDesc,
        category_id: fallbackCategoryId || undefined,
        quantity: 1,
        unit_price: cleanAmount,
      },
    ];
  };

  const additionalItems = normalizeItems();
  const additionalAddress = toAdditionalInfoAddress(address);
  paymentData.additional_info = {
    items: additionalItems,
    // Ajuda na análise de risco (quando disponível)
    ip_address: clientIp || undefined,
    payer: {
      ...(additionalAddress ? { address: additionalAddress } : {}),
      ...(payer?.dateRegistered || payer?.registrationDate
        ? { registration_date: payer.dateRegistered || payer.registrationDate }
        : {}),
    },
  };

  // Webhook
  const resolvedNotificationUrl = String(notificationUrl || MP_NOTIFICATION_URL || '').trim();
  if (resolvedNotificationUrl) {
    paymentData.notification_url = resolvedNotificationUrl;
  }

  // statement_descriptor
  const normalizedDescriptor = String(statementDescriptor || DEFAULT_STATEMENT_DESCRIPTOR || '')
    .trim()
    .slice(0, 16);
  if (normalizedDescriptor) {
    paymentData.statement_descriptor = normalizedDescriptor;
  }

  if (paymentMethod === 'credit_card') {
    if (!cardToken) {
      return res.status(400).json({ error: 'Token do cartão é obrigatório para pagamento com cartão.' });
    }

    const pmId = String(paymentMethodId || '').trim();
    const cardType = pmId || detectCardType(cardNumber);
    paymentData.payment_method_id = cardType;
    paymentData.token = cardToken;
    paymentData.installments =
      Number.isFinite(Number(installments)) && Number(installments) > 0 ? Number(installments) : 1;
    paymentData.capture = true;
    // binary_mode=true força "approved" ou "rejected" (menos "in_process").
    // Para reduzir recusas por risco e permitir análise, use MP_BINARY_MODE=false.
    paymentData.binary_mode = (process.env.MP_BINARY_MODE ?? 'false').toLowerCase() === 'true';
    paymentData.three_d_secure_mode = 'optional';

    // Opcional: metadata sem dados sensíveis (BIN/last4) para auditoria interna
    if (cardBin) paymentData.metadata.card_bin = String(cardBin);
    if (cardLast4) paymentData.metadata.card_last4 = String(cardLast4);
  } else {
    paymentData.payment_method_id = 'pix';
  }

  try {
    const mpHeaders = {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      // Repasse de antifraude
      ...(resolvedDeviceId ? { 'X-meli-session-id': resolvedDeviceId } : {}),
      ...(clientUserAgent ? { 'User-Agent': clientUserAgent } : {}),
    };

    const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
      headers: mpHeaders,
      timeout: 30000,
    });

    // Importante: o MP pode responder 200 mesmo com status="rejected".
    // Então ajustamos o HTTP status para o app tratar corretamente.
    const mpPayment = response.data;
    const httpStatus =
      mpPayment?.status === 'approved'
        ? 200
        : mpPayment?.status === 'in_process'
          ? 202
          : mpPayment?.status === 'rejected'
            ? 402
            : 200;

    res.status(httpStatus).json({
      ...response.data,
      external_reference: paymentData.external_reference,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const mp = error.response?.data;

    // Log rico no servidor ajuda a descobrir exatamente o motivo (status_detail/cause).
    console.error('Erro Mercado Pago /v1/payments:', {
      status,
      mp,
      message: error.message,
    });

    res.status(status).json({
      error: mp || error.message,
      mp_status: mp?.status,
      mp_status_detail: mp?.status_detail,
      mp_id: mp?.id,
      mp_message: mp?.message,
      mp_error: mp?.error,
      mp_cause: mp?.cause,
    });
  }
});

// Webhook Mercado Pago
app.post('/webhooks/mercadopago', (req, res) => {
  try {
    console.log('=== WEBHOOK Mercado Pago recebido ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao processar webhook Mercado Pago:', error.message);
    res.sendStatus(500);
  }
});

// Gera token de cartão no MP (usando PUBLIC_KEY + session-id)
app.post('/test-card-token', async (req, res) => {
  const { cardNumber, expirationMonth, expirationYear, cvv, cardholderName, cpf, deviceId } =
    req.body || {};

  try {
    if (!MP_PUBLIC_KEY) {
      return res.status(500).json({ error: 'MP public key ausente no servidor.' });
    }
    const cleanCpf = String(cpf || '').replace(/\D/g, '');
    const cleanCard = String(cardNumber || '').replace(/\D/g, '');
    const expMonth = parseInt(expirationMonth, 10);
    const expYear =
      String(expirationYear || '').length === 2
        ? parseInt(`20${expirationYear}`, 10)
        : parseInt(expirationYear, 10);

    const tokenData = {
      card_number: cleanCard,
      expiration_month: expMonth,
      expiration_year: expYear,
      security_code: String(cvv || ''),
      cardholder: {
        name: String(cardholderName || ''),
        identification: { type: 'CPF', number: cleanCpf },
      },
    };

    const resolvedDeviceId = getMeliSessionId(req, deviceId);

    const response = await axios.post(
      `https://api.mercadopago.com/v1/card_tokens?public_key=${encodeURIComponent(MP_PUBLIC_KEY)}`,
      tokenData,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(resolvedDeviceId ? { 'X-meli-session-id': resolvedDeviceId } : {}),
          ...(req.get('user-agent') ? { 'User-Agent': req.get('user-agent') } : {}),
        },
        timeout: 30000,
      }
    );

    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Consulta pagamento no MP
app.get('/payment-status/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      timeout: 30000,
    });
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Info PIX
app.get('/pix-info', (req, res) => {
  res.json({ pixKey: PIX_KEY, pixKeyType: PIX_KEY_TYPE, status: 'configured' });
});

const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, HOST, () => {
  console.log('Backend de pagamento rodando na porta HTTP', PORT);
});

if (SSL_ENABLED) {
  try {
    const { key, cert, source } = loadSslCredentials();
    const httpsOptions = {
      key,
      cert,
      minVersion: 'TLSv1.2',
      secureOptions: cryptoConstants.SSL_OP_NO_TLSv1 | cryptoConstants.SSL_OP_NO_TLSv1_1,
    };
    if (process.env.SSL_PASSPHRASE) httpsOptions.passphrase = process.env.SSL_PASSPHRASE;

    https.createServer(httpsOptions, app).listen(HTTPS_PORT, HOST, () => {
      console.log('=== HTTPS habilitado ===');
      console.log('Certificado SSL carregado de:', source);
      console.log('Backend rodando na porta HTTPS', HTTPS_PORT);
    });
  } catch (error) {
    console.warn(`⚠️ HTTPS não iniciado: ${error.message}`);
  }
}


