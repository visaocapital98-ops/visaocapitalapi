require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// CORS — Permite pedidos de qualquer origem.
// Não usamos cookies (tokens via headers), por isso não
// precisamos de credentials:true, o que é incompatível com *.
// ============================================================
app.use(cors());
app.options('*', cors()); // Responder a todos os preflight OPTIONS

app.use(express.json({ 
  limit: '50mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/webhooks/')) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Garantir que a pasta uploads existe
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configurar armazenamento Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Helper para guardar ficheiro na base de dados (LONGBLOB) para persistência permanente no Alwaysdata
async function saveFileToDb(file) {
  if (!file) return;
  try {
    const filePath = path.join(UPLOADS_DIR, file.filename);
    const fileData = fs.readFileSync(filePath);
    const date = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      'INSERT INTO stored_files (filename, mime_type, file_data, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE mime_type = ?, file_data = ?',
      [file.filename, file.mimetype, fileData, date, file.mimetype, fileData]
    );
    console.log(`Ficheiro persistido na BD: ${file.filename}`);
  } catch (err) {
    console.error(`Erro ao guardar ficheiro na BD (${file.filename}):`, err);
  }
}

// Servir ficheiros com fallback para a base de dados (evita perda de dados nos restarts do Railway)
app.get('/uploads/:filename', async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, filename);

  // Se já existe no disco, serve diretamente
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Se não existe no disco, procura na base de dados MySQL (Alwaysdata)
  try {
    const [rows] = await pool.query('SELECT mime_type, file_data FROM stored_files WHERE filename = ?', [filename]);
    if (rows.length === 0) {
      return res.status(404).send('Ficheiro não encontrado.');
    }

    const { mime_type, file_data } = rows[0];

    // Grava de volta no disco para acelerar acessos futuros (cache local no contentor)
    fs.writeFileSync(filePath, file_data);

    // Servir o ficheiro para o cliente com o Content-Type correto
    res.setHeader('Content-Type', mime_type);
    return res.send(file_data);
  } catch (err) {
    console.error('Erro ao recuperar ficheiro da BD:', err);
    return res.status(500).send('Erro interno ao recuperar ficheiro.');
  }
});

// Fallback adicional para a pasta estática
app.use('/uploads', express.static(UPLOADS_DIR));

// Conexão Pool MySQL
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 3306,
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0
};
const pool = mysql.createPool(dbConfig);

// Token-based Session Helpers (Zero dependencies)
const JWT_SECRET = process.env.JWT_SECRET || 'visaocapital_super_secret_session_key_2026';

function generateToken(payload) {
  const data = JSON.stringify({ ...payload, exp: Date.now() + 24 * 60 * 60 * 1000 }); // 24 horas expiração
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
  return Buffer.from(data).toString('base64') + '.' + signature;
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const data = Buffer.from(parts[0], 'base64').toString('utf8');
    const signature = parts[1];
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
    if (signature === expectedSignature) {
      const payload = JSON.parse(data);
      if (payload.exp && payload.exp < Date.now()) {
        return null; // Token expirado
      }
      return payload;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ============================================================
// CONFIGURAÇÃO SMTP & ENVIOS DE E-MAIL
// ============================================================
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true para 465, false para outras portas
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  console.log('Transporter SMTP inicializado com sucesso.');
} else {
  console.warn('Variáveis de e-mail SMTP em falta. As notificações por e-mail estão desativadas.');
}

async function sendOrderEmailNotification(order, isConfirmed = false) {
  if (!mailTransporter) {
    console.warn(`[E-mail] Envio ignorado para o pedido ${order.id} (transporter não inicializado).`);
    return;
  }

  const from = process.env.SMTP_FROM || `"Visão Capital" <${process.env.SMTP_USER}>`;
  const to = process.env.SMTP_TO || process.env.SMTP_USER;

  const subject = isConfirmed 
    ? `🚨 [Visão Capital] Novo Pagamento Confirmado - Pedido ${order.id}`
    : `📝 [Visão Capital] Novo Pedido Solicitado - Pedido ${order.id}`;

  const title = isConfirmed 
    ? `Pagamento Confirmado com Sucesso!`
    : `Novo Pedido Solicitado (Aguardando Aprovação)`;

  const introText = isConfirmed
    ? `O pagamento do seguinte pedido foi verificado e confirmado automaticamente pelo gateway de pagamentos:`
    : `Um cliente efetuou uma nova solicitação de serviço no site. Por favor, analise os dados e o comprovativo de pagamento no painel administrativo:`;

  const mailOptions = {
    from: from,
    to: to,
    subject: subject,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <h2 style="color: ${isConfirmed ? '#006400' : '#d35400'}; margin-top: 0;">${title}</h2>
        <p>${introText}</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold; width: 35%;">ID do Pedido:</td>
            <td style="padding: 10px; border: 1px solid #ddd; font-family: monospace; font-size: 1.05rem;">${order.id}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Serviço/Produto:</td>
            <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #333;">${order.servico}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Nome do Cliente:</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${order.cliente}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Contacto do Cliente:</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${order.contacto}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Valor do Serviço:</td>
            <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #006400;">${order.valor} Kz</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Ref. Transação:</td>
            <td style="padding: 10px; border: 1px solid #ddd; font-family: monospace; font-weight: bold;">${order.ref_transacao || 'N/A'}</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; background: #f9f9f9; font-weight: bold;">Afiliado Vinculado:</td>
            <td style="padding: 10px; border: 1px solid #ddd; color: #856404; font-family: monospace;">${order.afiliado || 'Nenhum'}</td>
          </tr>
        </table>
        <div style="margin-top: 20px; font-size: 0.85rem; color: #888; text-align: center;">
          Este é um e-mail gerado automaticamente pelo sistema da Visão Capital.
        </div>
      </div>
    `
  };

  try {
    await mailTransporter.sendMail(mailOptions);
    console.log(`[E-mail] Notificação enviada com sucesso para ${to} sobre o pedido ${order.id}.`);
  } catch (err) {
    console.error(`[E-mail] Erro ao enviar notificação para o pedido ${order.id}:`, err.message);
  }
}

async function handleSuccessfulPayment(orderId, amount) {
  try {
    // 1. Procurar o pedido na base de dados
    const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (orders.length === 0) {
      console.warn(`[Webhook] Pedido ${orderId} não encontrado no banco de dados.`);
      return;
    }

    const order = orders[0];

    // Se o pedido já estiver pago ou concluído, ignorar para evitar duplicar comissões/emails
    if (order.estado === 'pago' || order.estado === 'concluido') {
      console.log(`[Webhook] Pedido ${orderId} já se encontra com estado '${order.estado}'. Ignorado.`);
      return;
    }

    // 2. Atualizar o estado do pedido para 'pago'
    await pool.query('UPDATE orders SET estado = "pago" WHERE id = ?', [orderId]);
    console.log(`[Webhook] Pedido ${orderId} atualizado para 'pago'.`);

    // 3. Se houver um afiliado associado, atribuir comissão e notificar
    if (order.afiliado) {
      // Buscar o afiliado pelo código (a coluna orders.afiliado guarda o código canonical)
      const [affiliates] = await pool.query('SELECT * FROM affiliates WHERE code = ?', [order.afiliado]);
      if (affiliates.length > 0) {
        const affiliate = affiliates[0];

        // Obter taxa de comissão
        const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
        const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;
        const commissionAmount = Math.round(parsePrice(order.valor) * commRate);

        // Criar notificação para o afiliado
        const notifId = 'NT' + Date.now();
        const today = new Date().toISOString().slice(0, 10);
        const message = `🎉 Parabéns! A indicação do serviço "${order.servico}" do cliente ${order.cliente} foi confirmada e paga. Recebeu uma comissão de ${commissionAmount} Kz.`;

        await pool.query(
          'INSERT INTO notifications (id, titulo, message, tipo, destinatario, date) VALUES (?, ?, ?, ?, ?, ?)',
          [notifId, 'Comissão Confirmada', message, 'geral', affiliate.id, today]
        );
        console.log(`[Webhook] Notificação de comissão criada para o afiliado ${affiliate.nome} (${affiliate.id}).`);
      } else {
        console.warn(`[Webhook] Afiliado com código ${order.afiliado} não encontrado para atribuir comissão.`);
      }
    }

    // 4. Enviar notificação por e-mail à administração
    await sendOrderEmailNotification(order);

  } catch (err) {
    console.error(`[Webhook] Erro no processamento do pagamento bem-sucedido do pedido ${orderId}:`, err);
  }
}

async function triggerAdminWebhook(order) {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "webhook_url"');
    const webhookUrl = rows[0]?.setting_value;

    if (!webhookUrl || webhookUrl.trim() === '') {
      console.log('[Webhook Admin] Nenhuma URL de webhook configurada. Ignorando.');
      return;
    }

    console.log(`[Webhook Admin] Enviando notificação de novo pedido para: ${webhookUrl}`);

    const payload = {
      event: 'order.created',
      timestamp: new Date().toISOString(),
      data: {
        id: order.id,
        cliente: order.cliente,
        contacto: order.contacto,
        servico: order.servico,
        valor: order.valor,
        afiliado: order.afiliado || 'Nenhum',
        estado: 'novo'
      }
    };

    const res = await globalThis.fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VisaoCapital-Webhook/1.0'
      },
      body: JSON.stringify(payload)
    });

    console.log(`[Webhook Admin] Resposta do webhook (${res.status}): ${res.statusText}`);
  } catch (err) {
    console.error('[Webhook Admin] Erro ao disparar webhook de novo pedido:', err.message);
  }
}

async function validateReceiptWithGemini(fileBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
  if (!apiKey || apiKey === '') {
    console.warn('[Gemini AI] GEMINI_API_KEY não configurada. Ignorando validação por IA.');
    return { isReceipt: true, reason: 'Chave de API não configurada' };
  }

  try {
    const base64Data = fileBuffer.toString('base64');
    
    const payload = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            },
            {
              text: "Analise esta imagem. Trata-se de um comprovativo de transferência bancária, talão de depósito, recibo de pagamento ou e-mail/captura de ecrã de confirmação de pagamento legítimo? Responda estritamente em formato JSON válido, sem markdown, contendo apenas dois campos: \"is_receipt\" (booleano true se for um comprovativo e false se for qualquer outra imagem como selfies, capturas de ecrã aleatórias, memes, fotos pessoais, etc.) e \"confidence\" (número de 0 a 100). Exemplo: {\"is_receipt\": true, \"confidence\": 95}"
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await globalThis.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      console.error(`[Gemini AI] Erro na API do Gemini: ${response.status} ${response.statusText}`);
      return { isReceipt: true, reason: 'Erro de ligação à API' };
    }

    const data = await response.json();
    const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonText) {
      return { isReceipt: true, reason: 'Resposta vazia da API' };
    }

    const parsed = JSON.parse(jsonText.trim());
    console.log('[Gemini AI] Resultado da análise do talão:', parsed);

    return {
      isReceipt: parsed.is_receipt === true && parsed.confidence >= 70,
      confidence: parsed.confidence,
      reason: parsed.is_receipt ? 'Reconhecido como comprovativo' : 'Não reconhecido como comprovativo'
    };
  } catch (err) {
    console.error('[Gemini AI] Erro ao validar comprovativo com IA:', err.message);
    return { isReceipt: true, reason: 'Erro interno de processamento' };
  }
}

// Middlewares de Autenticação
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);
  const payload = verifyToken(token);
  if (payload && payload.role === 'admin') {
    req.admin = payload;
    next();
  } else {
    res.status(401).json({ error: 'Não autorizado como administrador' });
  }
}

function affiliateAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (payload && payload.role === 'affiliate') {
    req.affiliate = payload;
    next();
  } else {
    res.status(401).json({ error: 'Não autorizado como afiliado' });
  }
}

// Helper para formatar moeda e preços
function parsePrice(val) {
  if (!val) return 0;
  const s = String(val).replace(/[^\d.,]/g, '').replace(',', '.');
  const n = parseFloat(s.replace('.', ''));
  return isNaN(n) ? 0 : n;
}


// ==========================================
// 1. ROTAS PÚBLICAS
// ==========================================

// Obter todos os serviços
app.get('/api/services', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM services');
    const services = rows.map(s => ({
      ...s,
      fields: JSON.parse(s.fields)
    }));
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter avaliações aprovadas
app.get('/api/reviews/approved', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM reviews WHERE aprovado = 1 ORDER BY date DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submeter uma avaliação
app.post('/api/reviews', async (req, res) => {
  const { name, stars, comment, visitor_id } = req.body;
  if (!name || !stars || !comment) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  }
  try {
    const id = 'R' + Date.now();
    const date = new Date().toISOString().slice(0, 10);
    await pool.query(
      'INSERT INTO reviews (id, name, stars, comment, date, aprovado, visitor_id) VALUES (?, ?, ?, ?, ?, 0, ?)',
      [id, name, stars, comment, date, visitor_id || null]
    );
    res.json({ success: true, message: 'Avaliação submetida, aguarda aprovação.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter estatísticas públicas do site
app.get('/api/stats/public', async (req, res) => {
  try {
    const [[{ count: completed }]] = await pool.query('SELECT COUNT(*) as count FROM orders WHERE estado = "concluido"');
    const [[{ count: total }]] = await pool.query('SELECT COUNT(*) as count FROM orders');
    const [[{ count: affiliates }]] = await pool.query('SELECT COUNT(*) as count FROM affiliates WHERE estado = "ativo"');
    res.json({
      completed: completed + 12,
      total: total + 8,
      affiliates
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registar visita ao site (Tempo real e analíticas)
app.post('/api/visits', async (req, res) => {
  const { visitor_id } = req.body;
  if (!visitor_id) {
    return res.status(400).json({ error: 'visitor_id é obrigatório' });
  }

  // Obter IP do utilizador (lidando com cabeçalhos de proxies se houver)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  try {
    // Registar a visita na BD
    await pool.query(
      'INSERT INTO site_visits (visitor_id, ip_address, user_agent, visit_time) VALUES (?, ?, ?, NOW())',
      [visitor_id, ip.toString().split(',')[0].trim(), userAgent.substring(0, 255)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter configurações públicas (WhatsApp, Email, Dados de pagamento)
app.get('/api/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settings');
    const settings = {};
    rows.forEach(r => {
      settings[r.setting_key] = r.setting_value;
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook do Stripe para Confirmação de Pagamento
app.post('/api/webhooks/payment', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe) {
    console.error('[Webhook] Stripe SDK não inicializado (chave sk_live em falta).');
    return res.status(500).json({ error: 'Stripe SDK not initialized' });
  }

  if (!sig || !endpointSecret) {
    console.warn('[Webhook] Assinatura ou segredo do webhook em falta.');
    return res.status(400).send('Webhook Error: Missing signature or secret');
  }

  let event;

  try {
    if (!req.rawBody) {
      throw new Error('Raw body is empty or not parsed. Check express.json configuration.');
    }
    event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
  } catch (err) {
    console.error(`[Webhook] Falha na validação da assinatura: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Webhook] Evento recebido com sucesso: ${event.type}`);

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const object = event.data.object;
    const orderId = object.metadata && object.metadata.orderId;
    const amount = object.amount_total ? (object.amount_total / 100) : (object.amount ? (object.amount / 100) : 0);

    if (orderId) {
      console.log(`[Webhook] Processando pagamento com sucesso para o pedido: ${orderId}`);
      await handleSuccessfulPayment(orderId, amount);
    } else {
      console.warn('[Webhook] Evento processado mas "orderId" não foi encontrado nos metadados.');
    }
  }

  res.json({ received: true });
});

// Criar Pedido de Serviço (Com comprovativo e ficheiros opcionais)
app.post('/api/orders', upload.fields([
  { name: 'comprovativo', maxCount: 1 },
  { name: 'ficheiros', maxCount: 10 }
]), async (req, res) => {
  const { cliente_nome, cliente_tel, service_id, service_name, valor, afiliado, visitor_id, ref_transacao } = req.body;
  
  if (!cliente_nome || !cliente_tel || !service_id || !service_name || !valor) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  }

  if (!ref_transacao || ref_transacao.trim().length < 3) {
    return res.status(400).json({ error: 'Por favor, insira o número de referência ou ID de transação válido' });
  }

  const comprovativoFile = req.files && req.files['comprovativo'] ? req.files['comprovativo'][0] : null;
  const extraFiles = req.files && req.files['ficheiros'] ? req.files['ficheiros'] : [];

  if (!comprovativoFile) {
    return res.status(400).json({ error: 'Falta o comprovativo de pagamento' });
  }

  try {
    // 1. Validar comprovativo com Inteligência Artificial (Gemini)
    const filePath = path.join(UPLOADS_DIR, comprovativoFile.filename);
    const fileBuffer = await fs.promises.readFile(filePath);
    const aiCheck = await validateReceiptWithGemini(fileBuffer, comprovativoFile.mimetype);
    if (!aiCheck.isReceipt) {
      fs.promises.unlink(filePath).catch(err => console.error('Erro ao apagar comprovativo inválido:', err.message));
      return res.status(400).json({ error: 'O ficheiro enviado não foi reconhecido como um comprovativo de pagamento válido. Por favor, envie uma foto legível do talão de transferência ou PayPay.' });
    }

    const orderId = 'PD' + Date.now();
    const date = new Date().toISOString().slice(0, 10);
    const dateTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    const comprovativoPath = '/uploads/' + comprovativoFile.filename;
    const comprovativoName = comprovativoFile.originalname;

    // Extrair todos os campos do formulário (exceto os campos de controlo)
    const camposExcluidos = ['cliente_nome','cliente_tel','service_id','service_name','valor','afiliado','visitor_id','ref_transacao'];
    const detalhesObj = {};
    for (const [key, val] of Object.entries(req.body)) {
      if (!camposExcluidos.includes(key) && val && val.toString().trim() !== '') {
        detalhesObj[key] = val;
      }
    }
    const detalhesJSON = Object.keys(detalhesObj).length > 0 ? JSON.stringify(detalhesObj) : null;

    let resolvedCode = null;
    if (afiliado) {
      const [afRows] = await pool.query(
        'SELECT code FROM affiliates WHERE id = ? OR code = ?',
        [afiliado.trim(), afiliado.trim()]
      );
      if (afRows.length > 0) {
        resolvedCode = afRows[0].code;
      }
    }

    // Inserir pedido com detalhes
    await pool.query(
      `INSERT INTO orders 
      (id, date, date_time, cliente, contacto, servico, service_id, valor, afiliado, estado, detalhes, comprovativo_path, comprovativo_name, visitor_id, ref_transacao) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo', ?, ?, ?, ?, ?)`,
      [
        orderId, date, dateTime, cliente_nome, cliente_tel, 
        service_name, service_id, valor, resolvedCode,
        detalhesJSON, comprovativoPath, comprovativoName, visitor_id || null, ref_transacao.trim()
      ]
    );

    // Inserir ficheiros extras associados
    for (const file of extraFiles) {
      const filePath = '/uploads/' + file.filename;
      await pool.query(
        'INSERT INTO order_files (order_id, file_path, file_name) VALUES (?, ?, ?)',
        [orderId, filePath, file.originalname]
      );
    }

    // Persistir comprovativo e ficheiros na base de dados para evitar perda de dados
    await saveFileToDb(comprovativoFile);
    for (const file of extraFiles) {
      await saveFileToDb(file);
    }

    // Enviar notificação de novo pedido por e-mail ao administrador
    const newOrder = {
      id: orderId,
      servico: service_name,
      cliente: cliente_nome,
      contacto: cliente_tel,
      valor: valor,
      afiliado: resolvedCode,
      ref_transacao: ref_transacao.trim()
    };
    sendOrderEmailNotification(newOrder, false).catch(err => {
      console.error('[E-mail] Erro assíncrono ao enviar notificação de novo pedido:', err.message);
    });

    // Disparar o webhook de notificação para app externa do administrador
    triggerAdminWebhook(newOrder).catch(err => {
      console.error('[Webhook Admin] Erro assíncrono ao disparar webhook:', err.message);
    });

    res.json({ success: true, orderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter estado de um pedido público (por ID)
app.get('/api/orders/:id/status', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, cliente, servico, estado FROM orders WHERE id = ?', [req.params.id.trim()]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    const order = rows[0];

    // Mascarar o nome por privacidade (ex: "Paulo Calei" -> "P. Calei")
    let maskedName = order.cliente;
    const nameParts = order.cliente.split(' ').filter(p => p.trim() !== '');
    if (nameParts.length > 1) {
      maskedName = nameParts[0][0] + '. ' + nameParts[nameParts.length - 1];
    } else if (nameParts.length === 1) {
      maskedName = nameParts[0][0] + '...';
    }

    res.json({
      id: order.id,
      cliente: maskedName,
      servico: order.servico,
      estado: order.estado
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registar como Afiliado
app.post('/api/affiliates/register', upload.single('foto'), async (req, res) => {
  const { nome, idade, sexo, tel, email, endereco, banco_nome, banco, banco_titular, paypay, pass } = req.body;
  
  if (!nome || !idade || !sexo || !tel || !email || !endereco || !pass) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  }

  try {
    // Verificar se email já existe
    const [existing] = await pool.query('SELECT id FROM affiliates WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Este email já está registado' });
    }

    // Gerar código único de afiliado
    let code = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codeExists = true;
    while (codeExists) {
      code = 'VC-';
      for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
      const [check] = await pool.query('SELECT id FROM affiliates WHERE code = ?', [code]);
      if (check.length === 0) codeExists = false;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(pass, salt);
    
    const id = 'AF' + Date.now();
    const dateJoined = new Date().toISOString().slice(0, 10);
    const fotoPath = req.file ? '/uploads/' + req.file.filename : null;

    await pool.query(
      `INSERT INTO affiliates 
      (id, nome, idade, sexo, tel, email, endereco, banco_nome, banco, banco_titular, paypay, foto_path, pass, code, estado, date_joined) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', ?)`,
      [
        id, nome, parseInt(idade), sexo, tel, email, endereco, 
        banco_nome || null, banco || null, banco_titular || null, 
        paypay || null, fotoPath, hashedPassword, code, dateJoined
      ]
    );

    // Persistir foto de perfil na base de dados
    if (req.file) {
      await saveFileToDb(req.file);
    }

    res.json({ success: true, message: 'Registo efectuado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login do Afiliado
app.post('/api/affiliates/login', async (req, res) => {
  const { email, pass } = req.body;
  if (!email || !pass) {
    return res.status(400).json({ error: 'Email e palavra-passe obrigatórios' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM affiliates WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Credenciais incorrectas' });
    }

    const affiliate = rows[0];
    if (affiliate.estado === 'suspenso') {
      return res.status(400).json({ error: 'A sua conta está suspensa. Contacte o administrador.' });
    }

    const isMatch = await bcrypt.compare(pass, affiliate.pass);
    if (!isMatch) {
      // Fallback para senhas de teste antigas sem hash (apenas se coincidir literalmente)
      if (pass !== affiliate.pass) {
        return res.status(400).json({ error: 'Credenciais incorrectas' });
      }
    }

    const token = generateToken({
      role: 'affiliate',
      id: affiliate.id,
      code: affiliate.code,
      email: affiliate.email,
      nome: affiliate.nome
    });

    res.json({
      success: true,
      token,
      affiliate: {
        id: affiliate.id,
        nome: affiliate.nome,
        code: affiliate.code,
        email: affiliate.email
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login do Administrador
app.post('/api/admin/login', async (req, res) => {
  const { user, pass } = req.body;
  if (!user || !pass) {
    return res.status(400).json({ error: 'Utilizador e palavra-passe obrigatórios' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM admin WHERE username = ?', [user]);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Credenciais incorrectas' });
    }

    const admin = rows[0];
    const isMatch = await bcrypt.compare(pass, admin.password);
    if (!isMatch) {
      // Fallback para senhas antigas
      if (pass !== admin.password) {
        return res.status(400).json({ error: 'Credenciais incorrectas' });
      }
    }

    const token = generateToken({
      role: 'admin',
      id: admin.id,
      username: admin.username
    });

    res.json({
      success: true,
      token
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 2. ÁREA DO AFILIADO (PROTEGIDA)
// ==========================================

// Obter dados do dashboard do afiliado
app.get('/api/affiliates/dashboard', affiliateAuth, async (req, res) => {
  const afId = req.affiliate.id;
  const afCode = req.affiliate.code;

  try {
    // 1. Dados do perfil do afiliado
    const [afRows] = await pool.query(
      'SELECT id, nome, idade, sexo, tel, email, endereco, banco_nome, banco, banco_titular, paypay, foto_path, code, estado, date_joined FROM affiliates WHERE id = ?',
      [afId]
    );
    if (afRows.length === 0) {
      return res.status(404).json({ error: 'Afiliado não encontrado' });
    }
    const affiliate = afRows[0];

    // 2. Configuração de comissão atual
    const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
    const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;

    // 3. Obter todas as vendas (pedidos associados)
    const [orders] = await pool.query(
      'SELECT id, date, cliente, servico, valor, estado FROM orders WHERE afiliado = ? ORDER BY date_time DESC',
      [afCode]
    );

    // 4. Calcular estatísticas
    const paidOrders = orders.filter(o => o.estado === 'concluido');
    const pendingOrders = orders.filter(o => o.estado !== 'concluido');
    
    const totalSales = orders.length;
    const paidSales = paidOrders.length;
    const pendingSales = pendingOrders.length;

    const totalRevenue = paidOrders.reduce((acc, o) => acc + parsePrice(o.valor), 0);
    const commissionTotal = Math.round(totalRevenue * commRate);

    // 5. Levantamentos efetuados
    const [withdrawals] = await pool.query(
      'SELECT id, amount, method, date, estado FROM withdrawals WHERE affiliate_id = ? ORDER BY date DESC',
      [afId]
    );
    const withdrawnCommission = withdrawals
      .filter(w => w.estado === 'pago')
      .reduce((acc, w) => acc + parseFloat(w.amount), 0);

    const availableCommission = Math.max(0, commissionTotal - withdrawnCommission);

    // 6. Notificações recentes
    const [notifications] = await pool.query('SELECT * FROM notifications ORDER BY date DESC LIMIT 10');

    res.json({
      profile: affiliate,
      stats: {
        totalSales,
        paidSales,
        pendingSales,
        totalRevenue,
        commissionTotal,
        withdrawnCommission,
        availableCommission
      },
      orders,
      withdrawals,
      notifications
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pedir Levantamento de Comissão
app.post('/api/affiliates/withdraw', affiliateAuth, async (req, res) => {
  const afId = req.affiliate.id;
  const { amount, method, notes, banco_nome, conta, titular } = req.body;

  if (!amount || amount <= 0 || !method) {
    return res.status(400).json({ error: 'Valor e método de pagamento inválidos' });
  }

  try {
    // Verificar saldo do afiliado
    const [afRows] = await pool.query('SELECT code, nome, tel, email, banco_nome, banco, banco_titular, paypay FROM affiliates WHERE id = ?', [afId]);
    if (afRows.length === 0) return res.status(404).json({ error: 'Afiliado não encontrado' });
    const af = afRows[0];

    const [orders] = await pool.query('SELECT valor FROM orders WHERE afiliado = ? AND estado = "concluido"', [af.code]);
    const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
    const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;

    const totalRev = orders.reduce((acc, o) => acc + parsePrice(o.valor), 0);
    const commTotal = Math.round(totalRev * commRate);

    const [withdraws] = await pool.query('SELECT amount FROM withdrawals WHERE affiliate_id = ? AND estado = "pago"', [afId]);
    const withdrawn = withdraws.reduce((acc, w) => acc + parseFloat(w.amount), 0);

    const available = commTotal - withdrawn;

    if (amount > available) {
      return res.status(400).json({ error: 'Saldo insuficiente para levantamento.' });
    }

    const id = 'W' + Date.now();
    const date = new Date().toISOString().slice(0, 10);
    
    // Usar os dados enviados ou, se nulos, os registados
    const finalBanco = banco_nome || af.banco_nome || method;
    const finalConta = conta || af.banco || '';
    const finalTitular = titular || af.banco_titular || af.nome;

    await pool.query(
      `INSERT INTO withdrawals (id, affiliate_id, amount, method, notes, date, estado, banco_name, conta, titular) 
      VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`,
      [id, afId, amount, method, notes || null, date, finalBanco, finalConta, finalTitular]
    );

    res.json({ success: true, message: 'Pedido de levantamento enviado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar perfil do Afiliado (incluindo alteração de foto de perfil)
app.put('/api/affiliates/profile', affiliateAuth, upload.single('foto'), async (req, res) => {
  const afId = req.affiliate.id;
  const { nome, tel, endereco, banco_nome, banco, banco_titular, paypay } = req.body;
  
  if (!nome || !tel || !endereco) {
    return res.status(400).json({ error: 'Nome, telefone e endereço são obrigatórios.' });
  }

  try {
    let fotoPathQuery = '';
    const queryParams = [nome, tel, endereco, banco_nome || null, banco || null, banco_titular || null, paypay || null];

    if (req.file) {
      const fotoPath = '/uploads/' + req.file.filename;
      fotoPathQuery = ', foto_path = ?';
      queryParams.push(fotoPath);
      // Persistir no banco de dados
      await saveFileToDb(req.file);
    }

    queryParams.push(afId);

    await pool.query(
      `UPDATE affiliates SET nome = ?, tel = ?, endereco = ?, banco_nome = ?, banco = ?, banco_titular = ?, paypay = ? ${fotoPathQuery} WHERE id = ?`,
      queryParams
    );

    res.json({ success: true, message: 'Perfil atualizado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ==========================================
// 3. PAINEL DE ADMINISTRAÇÃO (PROTEGIDO)
// ==========================================

// Obter estatísticas de tráfego e conversão em tempo real e histórica para o administrador
app.get('/api/admin/traffic-stats', adminAuth, async (req, res) => {
  try {
    // 1. Visitantes ativos em tempo real (últimos 15 minutos)
    const [[{ active_visitors }]] = await pool.query(
      'SELECT COUNT(DISTINCT visitor_id) AS active_visitors FROM site_visits WHERE visit_time >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)'
    );

    // Helper query para obter estatísticas agregadas por período
    const getStatsForPeriod = async (intervalSql) => {
      const sql = `
        SELECT 
          COUNT(DISTINCT v.visitor_id) AS total_visitors,
          COUNT(DISTINCT CASE WHEN o.id IS NOT NULL THEN v.visitor_id END) AS ordered_visitors,
          COUNT(DISTINCT CASE WHEN r.id IS NOT NULL THEN v.visitor_id END) AS reviewed_visitors,
          COUNT(DISTINCT CASE WHEN o.id IS NULL AND r.id IS NULL THEN v.visitor_id END) AS only_visited_visitors
        FROM site_visits v
        LEFT JOIN orders o ON v.visitor_id = o.visitor_id
        LEFT JOIN reviews r ON v.visitor_id = r.visitor_id
        WHERE v.visit_time >= ${intervalSql}
      `;
      const [[result]] = await pool.query(sql);
      return {
        total_visitors: result.total_visitors || 0,
        ordered_visitors: result.ordered_visitors || 0,
        reviewed_visitors: result.reviewed_visitors || 0,
        only_visited_visitors: result.only_visited_visitors || 0
      };
    };

    const statsToday = await getStatsForPeriod('CURDATE()');
    const stats7Days = await getStatsForPeriod('DATE_SUB(NOW(), INTERVAL 7 DAY)');
    const statsMonth = await getStatsForPeriod('DATE_SUB(NOW(), INTERVAL 30 DAY)');
    const statsYear = await getStatsForPeriod('DATE_SUB(NOW(), INTERVAL 365 DAY)');

    // 2. Histórico diário dos últimos 7 dias (para gráfico/tabela)
    const dailyHistorySql = `
      SELECT 
        DATE(v.visit_time) AS date,
        COUNT(DISTINCT v.visitor_id) AS visitors,
        COUNT(DISTINCT o.id) AS orders,
        COUNT(DISTINCT r.id) AS reviews
      FROM site_visits v
      LEFT JOIN orders o ON v.visitor_id = o.visitor_id AND DATE(o.date_time) = DATE(v.visit_time)
      LEFT JOIN reviews r ON v.visitor_id = r.visitor_id AND DATE(r.date) = DATE(v.visit_time)
      WHERE v.visit_time >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY DATE(v.visit_time)
      ORDER BY DATE(v.visit_time) ASC
    `;
    const [dailyHistory] = await pool.query(dailyHistorySql);

    res.json({
      active_visitors: active_visitors || 0,
      periods: {
        today: statsToday,
        last7days: stats7Days,
        month: statsMonth,
        year: statsYear
      },
      daily_history: dailyHistory
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard geral do Admin
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  try {
    const [orders] = await pool.query('SELECT id, date, cliente, contacto, servico, valor, afiliado, estado, detalhes, comprovativo_path, comprovativo_name FROM orders ORDER BY date_time DESC');
    const [afs] = await pool.query('SELECT id FROM affiliates');
    const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
    const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;

    const completed = orders.filter(o => o.estado === 'concluido');
    const pending = orders.filter(o => ['novo', 'pendente'].includes(o.estado));

    const totalRevenue = completed.reduce((acc, o) => acc + parsePrice(o.valor), 0);
    const commissionsDue = completed.reduce((acc, o) => {
      if (o.afiliado) return acc + Math.round(parsePrice(o.valor) * commRate);
      return acc;
    }, 0);

    res.json({
      stats: {
        totalOrders: orders.length,
        completedOrders: completed.length,
        pendingOrders: pending.length,
        totalRevenue,
        totalAffiliates: afs.length,
        commissionsDue
      },
      recentOrders: orders.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter todos os pedidos (Admin)
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY date_time DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gestão de Pedidos (Apenas obter ficheiros associados a um pedido específico)
app.get('/api/admin/orders/:id/files', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM order_files WHERE order_id = ?', [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar estado ou dados do Pedido
app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  const { cliente, servico, valor, estado, observacoes } = req.body;
  try {
    await pool.query(
      'UPDATE orders SET cliente = ?, servico = ?, valor = ?, estado = ?, observacoes = ? WHERE id = ?',
      [cliente, servico, valor, estado, observacoes, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar Pedido
app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    // Obter caminhos dos ficheiros para os apagar fisicamente do disco
    const [files] = await pool.query('SELECT file_path FROM order_files WHERE order_id = ?', [req.params.id]);
    const [order] = await pool.query('SELECT comprovativo_path FROM orders WHERE id = ?', [req.params.id]);

    if (order.length > 0 && order[0].comprovativo_path) {
      const p = path.join(__dirname, order[0].comprovativo_path);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    for (const f of files) {
      const p = path.join(__dirname, f.file_path);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await pool.query('DELETE FROM orders WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter todos os afiliados (Admin)
app.get('/api/admin/affiliates', adminAuth, async (req, res) => {
  try {
    const [afs] = await pool.query(
      'SELECT id, nome, idade, sexo, tel, email, endereco, banco_nome, banco, banco_titular, paypay, foto_path, code, estado, date_joined FROM affiliates ORDER BY date_joined DESC'
    );

    // Enriquecer afiliados com dados de vendas calculados dinamicamente
    const [orders] = await pool.query('SELECT valor, afiliado, estado FROM orders WHERE estado = "concluido" AND afiliado IS NOT NULL');
    const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
    const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;

    const enriched = afs.map(a => {
      const afOrders = orders.filter(o => o.afiliado === a.code);
      const totalSales = afOrders.length;
      const totalRevenue = afOrders.reduce((acc, o) => acc + parsePrice(o.valor), 0);
      const commission = Math.round(totalRevenue * commRate);
      return {
        ...a,
        totalSales,
        commission
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alterar estado do afiliado (ativo / suspenso)
app.put('/api/admin/affiliates/:id/status', adminAuth, async (req, res) => {
  const { estado } = req.body;
  if (!['ativo', 'suspenso'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  try {
    await pool.query('UPDATE affiliates SET estado = ? WHERE id = ?', [estado, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar afiliado
app.delete('/api/admin/affiliates/:id', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT foto_path FROM affiliates WHERE id = ?', [req.params.id]);
    if (rows.length > 0 && rows[0].foto_path) {
      const p = path.join(__dirname, rows[0].foto_path);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await pool.query('DELETE FROM affiliates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter avaliações (Admin - moderação)
app.get('/api/admin/reviews', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM reviews ORDER BY date DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aprovar Avaliação
app.put('/api/admin/reviews/:id/approve', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE reviews SET aprovado = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar Avaliação
app.delete('/api/admin/reviews/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter Finanças (Admin)
app.get('/api/admin/finances', adminAuth, async (req, res) => {
  try {
    const [orders] = await pool.query('SELECT id, date, cliente, servico, valor, afiliado, estado FROM orders');
    const [expenses] = await pool.query('SELECT id, description, val, date, expense_type FROM expenses ORDER BY date DESC');
    const [withdrawals] = await pool.query('SELECT id, affiliate_id, amount, method, date, estado, banco_name, conta, titular, notes FROM withdrawals ORDER BY date DESC');
    const [afs] = await pool.query('SELECT code, nome, tel FROM affiliates');
    const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
    const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;

    const completed = orders.filter(o => o.estado === 'concluido');
    const pending = orders.filter(o => ['novo', 'pago', 'pendente'].includes(o.estado));

    const totalRevenue = completed.reduce((acc, o) => acc + parsePrice(o.valor), 0);
    const totalExpenses = expenses.reduce((acc, e) => acc + parseFloat(e.val), 0);
    const paidCommissions = withdrawals.filter(w => w.estado === 'pago').reduce((acc, w) => acc + parseFloat(w.amount), 0);
    
    // Comissão pendente = Comissão total calculada - comissões pagas
    const totalCommissionsCalculated = completed.filter(o => o.afiliado).reduce((acc, o) => acc + Math.round(parsePrice(o.valor) * commRate), 0);
    const pendingCommissions = Math.max(0, totalCommissionsCalculated - paidCommissions);
    
    const pendingPayments = pending.reduce((acc, o) => acc + parsePrice(o.valor), 0);
    const cashInHand = totalRevenue - totalExpenses - paidCommissions;

    // Construir histórico de transações
    const txns = [
      ...completed.map(o => ({ id: o.id, date: o.date, desc: 'Serviço: ' + o.servico + ' – ' + o.cliente, tipo: 'entrada', val: parsePrice(o.valor) })),
      ...expenses.map(e => ({ id: e.id, date: e.date, desc: e.description, tipo: 'saida', expense_type: e.expense_type || 'despesa', val: parseFloat(e.val) })),
      ...withdrawals.filter(w => w.estado === 'pago').map(w => {
        const af = afs.find(a => a.id === w.affiliate_id);
        return { id: w.id, date: w.date, desc: 'Comissão paga – ' + (af ? af.nome : 'Afiliado'), tipo: 'saida', val: parseFloat(w.amount) };
      })
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Mapear nome de afiliado para levantamento
    const withdrawalsEnriched = withdrawals.map(w => {
      const af = afs.find(a => a.id === w.affiliate_id);
      return {
        ...w,
        affiliateName: af ? af.nome : 'N/A',
        affiliateTel: af ? af.tel : 'N/A'
      };
    });

    res.json({
      summary: {
        cashInHand,
        totalRevenue,
        totalExpenses: totalExpenses + paidCommissions,
        netProfit: cashInHand,
        pendingCommissions,
        pendingPayments
      },
      transactions: txns,
      withdrawals: withdrawalsEnriched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registar Despesa (Saída Financeira)
app.post('/api/admin/expenses', adminAuth, async (req, res) => {
  const { description, val, expense_type } = req.body;
  if (!description || !val) {
    return res.status(400).json({ error: 'Descrição e valor obrigatórios' });
  }
  const tipo = (expense_type === 'comissao') ? 'comissao' : 'despesa';
  try {
    const id = 'E' + Date.now();
    const date = new Date().toISOString().slice(0, 10);
    await pool.query(
      'INSERT INTO expenses (id, description, val, date, expense_type) VALUES (?, ?, ?, ?, ?)',
      [id, description, parseFloat(val), date, tipo]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pagar Levantamento de Afiliado
app.put('/api/admin/withdrawals/:id/pay', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE withdrawals SET estado = "pago" WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rejeitar Levantamento de Afiliado
app.put('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE withdrawals SET estado = "rejeitado" WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar Configurações Gerais
app.put('/api/admin/settings', adminAuth, async (req, res) => {
  const settings = req.body;
  try {
    for (const [key, val] of Object.entries(settings)) {
      await pool.query(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [key, String(val), String(val)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Testar Webhook do Administrador
app.post('/api/admin/settings/test-webhook', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "webhook_url"');
    const webhookUrl = rows[0]?.setting_value;

    if (!webhookUrl || webhookUrl.trim() === '') {
      return res.status(400).json({ error: 'Nenhuma URL de webhook configurada. Guarde a URL primeiro.' });
    }

    const payload = {
      event: 'test.webhook',
      timestamp: new Date().toISOString(),
      data: {
        message: "Este é um teste de integração de webhook bem-sucedido a partir do painel da Visão Capital! 🚀",
        status: "active"
      }
    };

    const response = await globalThis.fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VisaoCapital-WebhookTest/1.0'
      },
      body: JSON.stringify(payload)
    });

    res.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar Credenciais do Administrador
app.put('/api/admin/credentials', adminAuth, async (req, res) => {
  const { user, pass } = req.body;
  if (!user || !pass) {
    return res.status(400).json({ error: 'Utilizador e palavra-passe obrigatórios' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(pass, salt);
    await pool.query('UPDATE admin SET username = ?, password = ? WHERE id = ?', [user, hashedPassword, req.admin.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar / Salvar Serviço (Admin)
app.post('/api/admin/services', adminAuth, async (req, res) => {
  const { name, price, icon, desc } = req.body;
  if (!name || !price || !icon || !desc) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }
  try {
    const id = 'sv' + Date.now();
    const defaultFields = JSON.stringify(['descricao', 'prazo', 'obs', 'ficheiros']);
    await pool.query(
      'INSERT INTO services (id, name, price, icon, description, fields) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, price, icon, desc, defaultFields]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar Serviço (Admin)
app.put('/api/admin/services/:id', adminAuth, async (req, res) => {
  const { name, price, icon, desc } = req.body;
  try {
    await pool.query(
      'UPDATE services SET name = ?, price = ?, icon = ?, description = ? WHERE id = ?',
      [name, price, icon, desc, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar Serviço (Admin)
app.delete('/api/admin/services/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM services WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar Notificação aos Afiliados (Admin)
app.post('/api/admin/notifications', adminAuth, async (req, res) => {
  const { message, titulo, tipo, destinatario } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
  try {
    const id = 'N' + Date.now();
    const date = new Date().toISOString().slice(0, 10);
    await pool.query(
      'INSERT INTO notifications (id, titulo, message, tipo, destinatario, date) VALUES (?, ?, ?, ?, ?, ?)',
      [id, titulo || 'Notificação', message, tipo || 'geral', destinatario || 'todos', date]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar todas as notificações enviadas (Admin)
app.get('/api/admin/notifications', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM notifications ORDER BY date DESC, id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar Notificação (Admin)
app.delete('/api/admin/notifications/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ranking de Afiliados (Admin)
app.get('/api/admin/affiliates/ranking', adminAuth, async (req, res) => {
  try {
    const [afs] = await pool.query(
      'SELECT id, nome, code, foto_path, date_joined FROM affiliates'
    );
    const [orders] = await pool.query('SELECT valor, afiliado FROM orders WHERE estado = "concluido" AND afiliado IS NOT NULL');
    const [setRows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "commission"');
    const commRate = parseInt(setRows[0]?.setting_value || '25') / 100;

    const ranking = afs.map(a => {
      const afOrders = orders.filter(o => o.afiliado === a.code);
      const totalSales = afOrders.length;
      const totalRevenue = afOrders.reduce((acc, o) => acc + parsePrice(o.valor), 0);
      const commission = Math.round(totalRevenue * commRate);
      return {
        id: a.id,
        nome: a.nome,
        code: a.code,
        foto_path: a.foto_path,
        totalSales,
        commission,
        totalRevenue
      };
    });

    // Ordenar por vendas decrescente, depois por comissão decrescente
    ranking.sort((x, y) => y.totalSales - x.totalSales || y.commission - x.commission);
    res.json(ranking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter notificações do Afiliado (Afiliado)
app.get('/api/affiliates/notifications', affiliateAuth, async (req, res) => {
  const afId = req.affiliate.id;
  try {
    const [rows] = await pool.query(
      `SELECT n.id, n.titulo, n.message, n.tipo, n.destinatario, n.date, 
              IF(r.notification_id IS NULL, 0, 1) as lida 
       FROM notifications n
       LEFT JOIN notification_reads r ON n.id = r.notification_id AND r.affiliate_id = ?
       WHERE n.destinatario = 'todos' OR n.destinatario = ?
       ORDER BY n.date DESC, n.id DESC`,
      [afId, afId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marcar notificação do Afiliado como lida
app.post('/api/affiliates/notifications/:id/read', affiliateAuth, async (req, res) => {
  const afId = req.affiliate.id;
  try {
    await pool.query(
      `INSERT INTO notification_reads (notification_id, affiliate_id, read_date) 
       VALUES (?, ?, NOW()) 
       ON DUPLICATE KEY UPDATE read_date = NOW()`,
      [req.params.id, afId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar Servidor — escutar em 0.0.0.0 para funcionar no Railway
app.listen(port, '0.0.0.0', () => {
  console.log(`API Visão Capital a correr na porta ${port}`);
});
