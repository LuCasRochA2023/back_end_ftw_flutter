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
app.use(express.json());
app.use(cors());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const DEFAULT_STATEMENT_DESCRIPTOR = (process.env.STATEMENT_DESCRIPTOR || process.env.MERCADO_PAGO_STATEMENT_DESCRIPTOR || '').trim();
const MP_NOTIFICATION_URL = (process.env.MP_NOTIFICATION_URL || process.env.NOTIFICATION_URL || '').trim();
// Configuração da chave PIX
const PIX_KEY = process.env.PIX_KEY;
const PIX_KEY_TYPE = process.env.PIX_KEY_TYPE; 

const SSL_ENABLED = (process.env.SSL_ENABLED ?? 'true').toLowerCase() !== 'false';
const SSL_AUTO_GENERATE = (process.env.SSL_AUTO_GENERATE ?? 'true').toLowerCase() !== 'false';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'selfsigned.cert.pem');
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, 'certs', 'selfsigned.key.pem');
const SSL_COMMON_NAME = process.env.SSL_COMMON_NAME || 'localhost';
const SSL_VALIDITY_DAYS = Number.isNaN(parseInt(process.env.SSL_VALIDITY_DAYS || '', 10))
  ? 365
  : parseInt(process.env.SSL_VALIDITY_DAYS, 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SSL_SAN = process.env.SSL_SAN || `DNS:${SSL_COMMON_NAME},DNS:localhost,IP:127.0.0.1`;

// Função para detectar o tipo de cartão baseado no BIN
function detectCardType(cardNumber) {
  const cleanNumber = cardNumber.replace(/\D/g, '');
  const firstTwo = parseInt(cleanNumber.substring(0, 2));
  const firstFour = parseInt(cleanNumber.substring(0, 4));
  const firstSix = parseInt(cleanNumber.substring(0, 6));

  // Visa
  if (cleanNumber.startsWith('4')) return 'visa';
  
  // Mastercard
  if (firstTwo >= 51 && firstTwo <= 55) return 'master';
  if (firstFour >= 2221 && firstFour <= 2720) return 'master';
  
  // American Express
  if (firstTwo === 34 || firstTwo === 37) return 'amex';
  
  // Elo
  if (firstFour === 636368 || firstFour === 438935 || firstFour === 504175 || 
      firstFour === 451416 || firstFour === 636297 || firstFour === 509048 ||
      firstFour === 509067 || firstFour === 509049 || firstFour === 509069 ||
      firstFour === 509050 || firstFour === 509074 || firstFour === 509068 ||
      firstFour === 509040 || firstFour === 509045 || firstFour === 509051 ||
      firstFour === 509046 || firstFour === 509066 || firstFour === 509047 ||
      firstFour === 509042 || firstFour === 509052 || firstFour === 509043 ||
      firstFour === 509064 || firstFour === 509040) return 'elo';
  
  // Hipercard
  if (firstSix === 606282) return 'hipercard';
  
  // Default to master for unknown cards
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
    execFileSync('openssl', [...baseArgs, '-addext', `subjectAltName=${SSL_SAN}`], { stdio: 'ignore' });
  } catch (error) {
    console.warn('Falha ao incluir subjectAltName via OpenSSL. Tentando gerar certificado sem SAN explícito.');
    try {
      execFileSync('openssl', baseArgs, { stdio: 'ignore' });
    } catch (secondaryError) {
      throw new Error(`Falha ao gerar certificado SSL com OpenSSL: ${secondaryError.message}`);
    }
  }

  console.log(`Certificado SSL autoassinado gerado com OpenSSL em ${SSL_CERT_PATH}`);

  return {
    key: fs.readFileSync(SSL_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(SSL_CERT_PATH, 'utf8'),
    source: 'generated',
  };
}

// Rota para testar configuração do Mercado Pago
app.get('/config-test', async (req, res) => {
  try {
    console.log('=== DEBUG: Testando configuração do Mercado Pago ===');
    console.log('Access Token:', MP_ACCESS_TOKEN ? 'Configurado' : 'Não configurado');
    console.log('PIX Key:', PIX_KEY);
    console.log('PIX Key Type:', PIX_KEY_TYPE);
    
    const response = await axios.get(
      'https://api.mercadopago.com/v1/payment_methods',
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        },
      }
    );
    
    console.log('✅ Configuração do Mercado Pago válida');
    res.json({ 
      status: 'ok', 
      message: 'Mercado Pago configurado corretamente',
      pixKey: PIX_KEY,
      pixKeyType: PIX_KEY_TYPE
    });
  } catch (error) {
    console.error('❌ Erro na configuração do Mercado Pago:', error.response?.data || error.message);
    res.status(400).json({ 
      status: 'error', 
      message: 'Token do Mercado Pago inválido ou sem permissões',
      error: error.response?.data || error.message
    });
  }
});

// Rota unificada para pagamento via Pix ou Cartão
app.post('/create-payment', async (req, res) => {
  const {
    amount,
    description,
    payer,
    cardToken, // opcional
    paymentMethod, // 'pix' ou 'credit_card'
    cardNumber, // necessário para detectar o tipo de cartão
    items, // opcional: [{ title, description, category_id|categoryId, quantity, unit_price }]
    categoryId, // opcional: categoria padrão quando items não vier
    notificationUrl, // opcional: sobrescreve notification_url por request
    deviceId, // opcional: Device Session ID do Mercado Pago (MP_DEVICE_SESSION_ID)
    externalReference, // opcional: ID interno para correlacionar payment_id no MP
    statementDescriptor,
  } = req.body;

  console.log('=== DEBUG: Recebendo requisição de pagamento ===');
  console.log('Dados recebidos:', { amount, description, paymentMethod, cardNumber: cardNumber?.substring(0, 6) + '...' });

  if (!amount || !description || !payer || !payer.email || !payer.cpf) {
    return res.status(400).json({ error: 'Parâmetros obrigatórios ausentes.' });
  }

  const idempotencyKey = uuidv4();
  const cleanCpf = payer.cpf.replace(/\D/g, '');

  const paymentData = {
    transaction_amount: parseFloat(amount),
    description,
    payer: {
      email: payer.email,
      first_name: payer.firstName || '',
      last_name: payer.lastName || '',
      identification: {
        type: 'CPF',
        number: cleanCpf,
      },
    },
    metadata: {
      integration: 'flutter_custom_screen',
      user_id: payer.userId || 'unknown',
    },
  };

  // external_reference: código único para correlacionar payment_id com ID interno do seu sistema
  const resolvedExternalReference = (externalReference || '').toString().trim() || uuidv4();
  paymentData.external_reference = resolvedExternalReference;

  // Enviar itens (com category_id) para melhorar análise de risco / aprovação no Mercado Pago.
  // Referência: Campo additional_info.items (Payments API).
  const DEFAULT_ITEM_CATEGORY_ID = (process.env.MP_DEFAULT_ITEM_CATEGORY_ID || '').trim();
  const fallbackCategoryId = (categoryId || DEFAULT_ITEM_CATEGORY_ID || '').trim();
  const normalizedAmount = parseFloat(amount);

  const normalizeItems = () => {
    // Se vier uma lista de items no request, normaliza e usa.
    if (Array.isArray(items) && items.length > 0) {
      const normalized = items
        .map((it) => {
          const quantity = Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1;
          const unitPrice = Number.isFinite(Number(it.unit_price)) && Number(it.unit_price) > 0
            ? Number(it.unit_price)
            : (Number.isFinite(normalizedAmount) ? normalizedAmount : 0);
          const category = (it.category_id || it.categoryId || fallbackCategoryId || '').toString().trim();

          return {
            id: it.id ? String(it.id) : undefined,
            title: it.title ? String(it.title) : String(description),
            description: it.description ? String(it.description) : String(description),
            category_id: category || undefined,
            quantity,
            unit_price: unitPrice,
          };
        })
        .filter((it) => Number(it.unit_price) > 0 && Number(it.quantity) > 0);

      if (normalized.length > 0) return normalized;
    }

    // Caso contrário, cria um item padrão usando description/amount.
    return [
      {
        title: String(description),
        description: String(description),
        category_id: fallbackCategoryId || undefined,
        quantity: 1,
        unit_price: Number.isFinite(normalizedAmount) ? normalizedAmount : 0,
      },
    ].filter((it) => Number(it.unit_price) > 0);
  };

  const additionalItems = normalizeItems();
  if (additionalItems.length > 0) {
    paymentData.additional_info = {
      items: additionalItems,
    };
    console.log('Itens enviados para análise de risco (additional_info.items):', JSON.stringify(additionalItems, null, 2));
  }

  // Webhook do Mercado Pago (Payments API)
  const resolvedNotificationUrl = (notificationUrl || MP_NOTIFICATION_URL || '').toString().trim();
  if (resolvedNotificationUrl) {
    paymentData.notification_url = resolvedNotificationUrl;
    console.log(`notification_url aplicado: ${resolvedNotificationUrl}`);
  }

  const normalizedDescriptor = (statementDescriptor || DEFAULT_STATEMENT_DESCRIPTOR || '').trim().slice(0, 16);
  if (normalizedDescriptor) {
    paymentData.statement_descriptor = normalizedDescriptor;
    console.log(`Statement descriptor aplicado: ${normalizedDescriptor}`);
  }

  if (paymentMethod === 'credit_card') {
    if (!cardToken) {
      return res.status(400).json({ error: 'Token do cartão é obrigatório para pagamento com cartão.' });
    }
    
    if (!cardNumber) {
      return res.status(400).json({ error: 'Número do cartão é obrigatório para detectar o tipo de cartão.' });
    }
    
    // Detectar o tipo de cartão baseado no número
    let cardType = 'master'; // fallback
    if (cardNumber) {
      cardType = detectCardType(cardNumber);
    }
    
    paymentData.payment_method_id = cardType;
    paymentData.token = cardToken;
    paymentData.installments = 1;
    
    // Adicionar dados específicos para cartão
    paymentData.capture = true; // Capturar o pagamento imediatamente
    paymentData.binary_mode = true; // Modo binário para evitar pagamentos pendentes
    
    console.log(`Detectado tipo de cartão: ${cardType} para BIN: ${cardNumber?.substring(0, 6)}`);
    console.log(`Token do cartão recebido: ${cardToken}`);
  } else {
    // Para PIX - apenas definir o método de pagamento
    // O Mercado Pago gera automaticamente o QR code
    paymentData.payment_method_id = 'pix';
    
    console.log('=== DEBUG: Configurando PIX com chave cadastrada ===');
    console.log('PIX Key:', PIX_KEY);
    console.log('PIX Key Type:', PIX_KEY_TYPE);
  }

  try {
    const resolvedDeviceId = (deviceId || req.headers['x-meli-session-id'] || req.headers['x-meli-sessionid'] || '')
      .toString()
      .trim();

    console.log('=== DEBUG: Enviando dados para Mercado Pago ===');
    console.log('Token do cartão:', cardToken);
    console.log('Número do cartão:', cardNumber);
    console.log('Tipo de cartão detectado:', paymentMethod === 'credit_card' ? detectCardType(cardNumber) : 'pix');
    console.log('Dados enviados para Mercado Pago:', JSON.stringify(paymentData, null, 2));
    
    const response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      paymentData,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
          ...(resolvedDeviceId ? { 'X-meli-session-id': resolvedDeviceId } : {}),
        },
      }
    );
    
    console.log('=== DEBUG: Resposta do Mercado Pago ===');
    console.log('Status:', response.data.status);
    console.log('Status Detail:', response.data.status_detail);
    console.log('Payment ID:', response.data.id);
    
    // Para PIX, verificar se o QR code foi gerado
    if (paymentMethod === 'pix' && response.data.point_of_interaction) {
      const qrCode = response.data.point_of_interaction.transaction_data?.qr_code;
      const qrCodeBase64 = response.data.point_of_interaction.transaction_data?.qr_code_base64;
      
      console.log('QR Code gerado:', qrCode ? 'Sim' : 'Não');
      console.log('QR Code Base64:', qrCodeBase64 ? 'Sim' : 'Não');
      
      if (!qrCode) {
        console.log('⚠️ QR Code não foi gerado - verificar configuração da chave PIX');
      }
    }
    
    console.log('Resposta completa:', JSON.stringify(response.data, null, 2));
    
    // Verificar se o pagamento foi aprovado
    if (response.data.status === 'approved') {
      console.log('✅ Pagamento aprovado com sucesso!');
    } else if (response.data.status === 'in_process') {
      console.log('⏳ Pagamento em processamento - pode precisar de revisão manual');
    } else if (response.data.status === 'rejected') {
      console.log('❌ Pagamento rejeitado');
    }
    
    // Inclui o external_reference usado para facilitar correlação no cliente
    res.status(200).json({ ...response.data, external_reference: resolvedExternalReference });
  } catch (error) {
    console.error('Erro ao criar pagamento:', error.response?.data || error.message);
    
    // Tratamento específico para erro de BIN
    if (error.response?.data?.cause?.[0]?.code === 10103) {
      return res.status(400).json({
        error: 'Erro de BIN do cartão',
        message: 'O tipo de cartão não corresponde ao BIN informado. Verifique os dados do cartão.',
        details: error.response.data
      });
    }
    
    // Tratamento específico para erro de configuração PIX
    if (error.response?.data?.error?.message?.includes('Collector user without key enabled for QR render')) {
      return res.status(400).json({
        error: 'Erro de configuração PIX',
        message: 'Conta do Mercado Pago não tem permissões para gerar QR Code. Verifique as configurações da conta.',
        details: error.response.data
      });
    }
    
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Endpoint para receber notificações (Webhook) do Mercado Pago.
// Configure MP_NOTIFICATION_URL (ou NOTIFICATION_URL) apontando para esta rota pública.
app.post('/webhooks/mercadopago', (req, res) => {
  try {
    // Mercado Pago pode enviar diferentes formatos dependendo do produto/config.
    // Registramos o payload completo para debug/auditoria.
    console.log('=== WEBHOOK Mercado Pago recebido ===');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));

    // Responder 200 rápido para evitar retries.
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao processar webhook Mercado Pago:', error.message);
    res.sendStatus(500);
  }
});

// Rota para testar token do cartão
app.post('/test-card-token', async (req, res) => {
  const { cardNumber, expirationMonth, expirationYear, cvv, cardholderName, cpf } = req.body;
  
  try {
    const cleanCpf = cpf.replace(/\D/g, '');
    const cleanCard = cardNumber.replace(/\D/g, '');
    
    const tokenData = {
      card_number: cleanCard,
      expiration_month: parseInt(expirationMonth),
      expiration_year: expirationYear.length === 2 ? parseInt(`20${expirationYear}`) : parseInt(expirationYear),
      security_code: cvv,
      cardholder: {
        name: cardholderName,
        identification: {
          type: 'CPF',
          number: cleanCpf,
        },
      },
    };
    
    console.log('=== DEBUG: Testando token do cartão ===');
    console.log('Dados do cartão:', JSON.stringify(tokenData, null, 2));
    
    const response = await axios.post(
      'https://api.mercadopago.com/v1/card_tokens',
      tokenData,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
    
    console.log('Token gerado:', response.data);
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Erro ao gerar token:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Rota para consultar status do pagamento
app.get('/payment-status/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        },
      }
    );
    
    console.log('=== DEBUG: Status do pagamento ===');
    console.log('Payment ID:', id);
    console.log('Status:', response.data.status);
    console.log('Status Detail:', response.data.status_detail);
    
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Erro ao consultar pagamento:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// Rota para obter informações da chave PIX
app.get('/pix-info', (req, res) => {
  res.json({
    pixKey: PIX_KEY,
    pixKeyType: PIX_KEY_TYPE,
    status: 'configured'
  });
});

// Checkout Pro: criar preferência (Preferences API)
// Envie notification_url no request de "Preferências" para habilitar Webhooks.
app.post('/create-preference', async (req, res) => {
  const {
    items,
    payer,
    notificationUrl, // opcional: sobrescreve notification_url por request
    externalReference,
    backUrls,
    autoReturn,
    statementDescriptor,
    deviceId, // opcional: Device Session ID do Mercado Pago (MP_DEVICE_SESSION_ID)
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items é obrigatório para criar preferência.' });
  }

  const normalizedItems = items.map((it) => ({
    id: it.id ? String(it.id) : undefined,
    title: it.title ? String(it.title) : undefined,
    description: it.description ? String(it.description) : undefined,
    category_id: (it.category_id || it.categoryId || '').toString().trim() || undefined,
    quantity: Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1,
    unit_price: Number.isFinite(Number(it.unit_price)) ? Number(it.unit_price) : undefined,
    currency_id: it.currency_id ? String(it.currency_id) : undefined,
  }));

  const resolvedNotificationUrl = (notificationUrl || MP_NOTIFICATION_URL || '').toString().trim();
  const normalizedDescriptor = (statementDescriptor || DEFAULT_STATEMENT_DESCRIPTOR || '').trim().slice(0, 16);
  const resolvedExternalReference = (externalReference || '').toString().trim() || uuidv4();
  const resolvedDeviceId = (deviceId || req.headers['x-meli-session-id'] || req.headers['x-meli-sessionid'] || '')
    .toString()
    .trim();

  const preferenceData = {
    items: normalizedItems,
  };

  if (payer?.email) {
    preferenceData.payer = {
      email: payer.email,
      name: payer.firstName || payer.name || '',
      surname: payer.lastName || payer.surname || '',
    };
  }

  if (resolvedNotificationUrl) {
    preferenceData.notification_url = resolvedNotificationUrl;
  }

  // external_reference: código único para correlacionar payment_id com ID interno do seu sistema
  preferenceData.external_reference = resolvedExternalReference;

  if (backUrls && typeof backUrls === 'object') {
    preferenceData.back_urls = backUrls;
  }

  if (autoReturn) {
    preferenceData.auto_return = String(autoReturn);
  }

  if (normalizedDescriptor) {
    // Campo usado no Checkout Pro para fatura/cartão, quando aplicável
    preferenceData.statement_descriptor = normalizedDescriptor;
  }

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      preferenceData,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          ...(resolvedDeviceId ? { 'X-meli-session-id': resolvedDeviceId } : {}),
        },
      }
    );

    // Inclui o external_reference usado (em geral o MP também devolve esse campo)
    res.status(200).json({ ...response.data, external_reference: resolvedExternalReference });
  } catch (error) {
    console.error('Erro ao criar preferência:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

const PORT = parseInt(process.env.PORT || '3001', 10);

app.listen(PORT, HOST, () => {
  console.log('=== DEBUG: Configuração do Backend ===');
  console.log('Access Token:', MP_ACCESS_TOKEN ? 'Configurado' : 'Não configurado');
  console.log('PIX Key:', PIX_KEY);
  console.log('PIX Key Type:', PIX_KEY_TYPE);
  console.log(`Backend de pagamento rodando na porta HTTP ${PORT}`);
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

    if (process.env.SSL_PASSPHRASE) {
      httpsOptions.passphrase = process.env.SSL_PASSPHRASE;
    }

    https.createServer(httpsOptions, app).listen(HTTPS_PORT, HOST, () => {
      console.log('=== DEBUG: HTTPS habilitado ===');
      console.log(`Certificado SSL carregado de: ${source === 'generated' ? 'auto-gerado' : 'arquivo existente'}`);
      console.log('Versão mínima TLS aplicadas: TLSv1.2');
      console.log(`Backend de pagamento rodando na porta HTTPS ${HTTPS_PORT}`);
    });
  } catch (error) {
    console.warn(`⚠️ HTTPS não iniciado: ${error.message}`);
  }
} else {
  console.log('HTTPS desabilitado. Defina SSL_ENABLED=true para ativar.');
}