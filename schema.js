require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 3306
};

async function initializeDatabase() {
  console.log('Ligando à base de dados MySQL:', dbConfig.host);
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('Conexão estabelecida com sucesso!');

    // 1. Tabela Admin
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "admin" verificada/criada.');

    // 2. Tabela Services
    await connection.query(`
      CREATE TABLE IF NOT EXISTS services (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price VARCHAR(100) NOT NULL,
        icon VARCHAR(50) NOT NULL,
        description TEXT NOT NULL,
        fields TEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "services" verificada/criada.');

    // 3. Tabela Settings
    await connection.query(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key VARCHAR(50) PRIMARY KEY,
        setting_value TEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "settings" verificada/criada.');

    // 4. Tabela Affiliates
    await connection.query(`
      CREATE TABLE IF NOT EXISTS affiliates (
        id VARCHAR(50) PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        idade INT NOT NULL,
        sexo VARCHAR(20) NOT NULL,
        tel VARCHAR(50) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        endereco VARCHAR(255) NOT NULL,
        banco_nome VARCHAR(100) DEFAULT NULL,
        banco VARCHAR(100) DEFAULT NULL,
        banco_titular VARCHAR(255) DEFAULT NULL,
        paypay VARCHAR(100) DEFAULT NULL,
        foto_path VARCHAR(255) DEFAULT NULL,
        pass VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE NOT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'ativo',
        date_joined DATE NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "affiliates" verificada/criada.');

    // 5. Tabela Orders
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(50) PRIMARY KEY,
        date DATE NOT NULL,
        date_time DATETIME NOT NULL,
        cliente VARCHAR(255) NOT NULL,
        contacto VARCHAR(255) NOT NULL,
        servico VARCHAR(255) NOT NULL,
        service_id VARCHAR(50) NOT NULL,
        valor VARCHAR(100) NOT NULL,
        afiliado VARCHAR(50) DEFAULT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'novo'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "orders" verificada/criada.');

    // Adicionar colunas se ainda nao existirem (para bases de dados ja existentes)
    const ordersColumns = [
      { name: 'observacoes', type: 'TEXT DEFAULT NULL' },
      { name: 'detalhes', type: 'LONGTEXT DEFAULT NULL' },
      { name: 'comprovativo_path', type: 'VARCHAR(255) DEFAULT NULL' },
      { name: 'comprovativo_name', type: 'VARCHAR(255) DEFAULT NULL' },
      { name: 'visitor_id', type: 'VARCHAR(50) DEFAULT NULL' },
      { name: 'ref_transacao', type: 'VARCHAR(100) DEFAULT NULL' }
    ];

    for (const col of ordersColumns) {
      try {
        await connection.query(`ALTER TABLE orders ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Coluna "${col.name}" adicionada à tabela orders.`);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
      }
    }

    // 6. Tabela Order Files
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id VARCHAR(50) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "order_files" verificada/criada.');

    // 7. Tabela Reviews
    await connection.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        stars INT NOT NULL,
        comment TEXT NOT NULL,
        date DATE NOT NULL,
        aprovado TINYINT(1) NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "reviews" verificada/criada.');

    // Adicionar coluna visitor_id se ainda nao existir
    try {
      await connection.query(`ALTER TABLE reviews ADD COLUMN visitor_id VARCHAR(50) DEFAULT NULL`);
      console.log('Coluna "visitor_id" adicionada à tabela reviews.');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // 8. Tabela Expenses
    await connection.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id VARCHAR(50) PRIMARY KEY,
        description VARCHAR(255) NOT NULL,
        val DECIMAL(10,2) NOT NULL,
        date DATE NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "expenses" verificada/criada.');

    // 9. Tabela Withdrawals
    await connection.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id VARCHAR(50) PRIMARY KEY,
        affiliate_id VARCHAR(50) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        method VARCHAR(100) NOT NULL,
        notes TEXT DEFAULT NULL,
        date DATE NOT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'pendente',
        banco_name VARCHAR(100) DEFAULT NULL,
        conta VARCHAR(100) DEFAULT NULL,
        titular VARCHAR(255) DEFAULT NULL,
        FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "withdrawals" verificada/criada.');

    // 10. Tabela Notifications
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id VARCHAR(50) PRIMARY KEY,
        titulo VARCHAR(255) DEFAULT 'Notificação',
        message TEXT NOT NULL,
        tipo VARCHAR(50) DEFAULT 'geral',
        destinatario VARCHAR(50) DEFAULT 'todos',
        date DATE NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "notifications" verificada/criada.');

    // Adicionar colunas se ainda nao existirem (para base de dados ja existente)
    const columnsToModify = [
      { name: 'titulo', type: "VARCHAR(255) DEFAULT 'Notificação'" },
      { name: 'tipo', type: "VARCHAR(50) DEFAULT 'geral'" },
      { name: 'destinatario', type: "VARCHAR(50) DEFAULT 'todos'" }
    ];
    for (const col of columnsToModify) {
      try {
        await connection.query(`ALTER TABLE notifications ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Coluna "${col.name}" adicionada à tabela notifications.`);
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
      }
    }

    // 11. Tabela Notification Reads (para saber se o afiliado ja leu a notificacao)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notification_reads (
        notification_id VARCHAR(50) NOT NULL,
        affiliate_id VARCHAR(50) NOT NULL,
        read_date DATETIME NOT NULL,
        PRIMARY KEY (notification_id, affiliate_id),
        FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
        FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // 12. Tabela Stored Files (para persistência de uploads em banco de dados)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stored_files (
        filename VARCHAR(255) PRIMARY KEY,
        mime_type VARCHAR(100) NOT NULL,
        file_data LONGBLOB NOT NULL,
        created_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "stored_files" verificada/criada.');

    // 13. Tabela Site Visits (para monitorização de visitas e conversão)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS site_visits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        visitor_id VARCHAR(50) NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        user_agent VARCHAR(255) NOT NULL,
        visit_time DATETIME NOT NULL,
        INDEX (visit_time),
        INDEX (visitor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tabela "site_visits" verificada/criada.');

    // Adicionar coluna user_agent se não existir
    try {
      await connection.query(`ALTER TABLE site_visits ADD COLUMN user_agent VARCHAR(255) NOT NULL AFTER ip_address`);
      console.log('Coluna "user_agent" adicionada à tabela site_visits.');
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }


    // --- INSERÇÃO DE DADOS PADRÃO ---

    // 1. Inserir Admin padrão se não existir
    const [admins] = await connection.query('SELECT * FROM admin WHERE username = ?', ['admin']);
    if (admins.length === 0) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('visaocapital2024', salt);
      await connection.query('INSERT INTO admin (username, password) VALUES (?, ?)', ['admin', hashedPassword]);
      console.log('Administrador padrão adicionado (admin / visaocapital2024).');
    }

    // 2. Inserir Configurações padrão se não existirem
    const defaultSettings = {
      whatsapp: '244959519835',
      email: 'visaocapital98@gmail.com',
      bic_name: 'DOMINGOS DA SILVA CALEI',
      bic_account: '005100005744156310133',
      paypay_name: 'PAULO DE JESUS NICOLAU CALEI',
      paypay_entity: '10116',
      paypay_ref: '936410545',
      commission: '25'
    };

    for (const [key, val] of Object.entries(defaultSettings)) {
      const [existing] = await connection.query('SELECT * FROM settings WHERE setting_key = ?', [key]);
      if (existing.length === 0) {
        await connection.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [key, val]);
        console.log(`Configuração padrão inserida: ${key} = ${val}`);
      }
    }

    // 3. Inserir Serviços padrão se não existirem
    const defaultServices = [
      {
        id: 'curriculo',
        name: 'Currículo Profissional',
        price: '1.500',
        icon: '📄',
        description: 'Currículo moderno e profissional adaptado ao mercado angolano.',
        fields: JSON.stringify(['nome','contacto','email','endereco','objetivo','formacao','experiencia','cursos','competencias','idiomas','certificados'])
      },
      {
        id: 'carta',
        name: 'Carta de Apresentação',
        price: '1.000',
        icon: '✉️',
        description: 'Carta de apresentação personalizada e profissional.',
        fields: JSON.stringify(['nome','contacto','email','empresa','cargo','motivacao','anexo'])
      },
      {
        id: 'trabalho_escolar',
        name: 'Trabalhos Escolares',
        price: 'A partir de 1.500',
        icon: '📚',
        description: 'Trabalhos escolares de qualidade com formatação adequada.',
        fields: JSON.stringify(['tema','classe','disciplina','professor','tipo_trabalho_escolar','num_paginas','prazo','instrucoes','nota_pretendida','ficheiros'])
      },
      {
        id: 'trabalho_academico',
        name: 'Trabalhos Académicos',
        price: 'A partir de 2.500',
        icon: '🎓',
        description: 'Trabalhos académicos com normas APA, referências e formatação completa.',
        fields: JSON.stringify(['tema','curso','classe','orientador','tipo_trabalho_academico','normas_citacao','num_paginas','num_referencias','prazo','instrucoes_prof','ficheiros'])
      },
      {
        id: 'powerpoint',
        name: 'Apresentações PowerPoint',
        price: 'A partir de 1.500',
        icon: '📊',
        description: 'Apresentações visuais impactantes e profissionais.',
        fields: JSON.stringify(['tema','num_slides','estilo','cores','conteudo','ficheiros'])
      },
      {
        id: 'digitalizacao',
        name: 'Digitalização de Documentos',
        price: 'A partir de 500',
        icon: '🖨️',
        description: 'Digitalização de alta qualidade em formato PDF ou JPG.',
        fields: JSON.stringify(['tipo_doc','num_paginas','formato_saida','obs'])
      },
      {
        id: 'outro',
        name: 'Outro Serviço',
        price: 'Preço Personalizado',
        icon: '⚡',
        description: 'Não encontrou o que precisa? Fale connosco.',
        fields: JSON.stringify(['descricao','prazo','obs','ficheiros'])
      }
    ];

    for (const service of defaultServices) {
      const [existing] = await connection.query('SELECT * FROM services WHERE id = ?', [service.id]);
      if (existing.length === 0) {
        await connection.query(
          'INSERT INTO services (id, name, price, icon, description, fields) VALUES (?, ?, ?, ?, ?, ?)',
          [service.id, service.name, service.price, service.icon, service.description, service.fields]
        );
        console.log(`Serviço padrão inserido: ${service.name}`);
      }
    }

    console.log('Inicialização da base de dados concluída com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar a base de dados:', error);
  } finally {
    if (connection) {
      await connection.end();
      console.log('Conexão fechada.');
    }
  }
}

initializeDatabase();
