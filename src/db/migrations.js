function runMigrations({ db, DEFAULT_SETTINGS, getSettings, addTreasuryEntry }) {
  // Create table with updated schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      nid TEXT NOT NULL,
      name TEXT,
      username TEXT,
      email TEXT,
      island TEXT,
      contribution_type TEXT,
      donation_amount REAL DEFAULT 0,
      initial_merit_estimate INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 1,
      auth_token TEXT,
      unregistered_at TEXT,
      unregistered_by TEXT,
      unregister_justification TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  // Migration: Add missing columns to existing signups table
  const signupMigrations = [
    { col: 'is_verified', def: 'INTEGER DEFAULT 1' },
    { col: 'username', def: 'TEXT' },
    { col: 'auth_token', def: 'TEXT' },
    { col: 'unregistered_at', def: 'TEXT' },
    { col: 'unregistered_by', def: 'TEXT' },
    { col: 'unregister_justification', def: 'TEXT' }
  ];

  signupMigrations.forEach(m => {
    try {
      db.exec(`ALTER TABLE signups ADD COLUMN ${m.col} ${m.def}`);
      console.log(`✓ Migration: Added ${m.col} to signups`);
    } catch (e) {
      // Column already exists or other error - ignore
    }
  });

  // Migration: Add last_login column for tracking user visits
  try {
    db.exec(`ALTER TABLE signups ADD COLUMN last_login TEXT`);
    console.log(`✓ Migration: Added last_login to signups`);
  } catch (e) {
    // Column already exists or other error - ignore
  }

  // Migration: SMS OTP verification columns
  try { db.exec(`ALTER TABLE signups ADD COLUMN otp_code TEXT`); console.log('✓ Migration: Added otp_code to signups'); } catch (e) {}
  try { db.exec(`ALTER TABLE signups ADD COLUMN otp_expires_at TEXT`); console.log('✓ Migration: Added otp_expires_at to signups'); } catch (e) {}
  try { db.exec(`ALTER TABLE signups ADD COLUMN otp_verified INTEGER DEFAULT 0`); console.log('✓ Migration: Added otp_verified to signups'); } catch (e) {}

  // Fix signups table schema - remove CHECK constraint if it exists
  // Only run once: if signups_new already exists we know this migration was done before
  try {
    const signupsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signups'`).get();
    const signupsNewExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='signups_new'`).get();
    if (!signupsExists || signupsNewExists) {
      console.log('✓ Signups table schema already correct');
    } else {
      db.exec(`CREATE TABLE signups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        nid TEXT NOT NULL,
        name TEXT,
        username TEXT,
        email TEXT,
        island TEXT,
        contribution_type TEXT,
        donation_amount REAL DEFAULT 0,
        initial_merit_estimate INTEGER DEFAULT 0,
        is_verified INTEGER DEFAULT 1,
        auth_token TEXT,
        unregistered_at TEXT,
        unregistered_by TEXT,
        unregister_justification TEXT,
        timestamp TEXT NOT NULL
      )`);

      db.exec(`INSERT INTO signups_new (id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp)
               SELECT id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp FROM signups`);

      db.exec('DROP TABLE signups');
      db.exec('ALTER TABLE signups_new RENAME TO signups');
      console.log('✓ Migration: Fixed signups table schema');
    }
  } catch (e) {
    console.log('✓ Signups table schema already correct');
  }

  // Migration: Make phone and nid nullable for privacy-preserving enrollments
  try {
    const cols = db.prepare(`PRAGMA table_info(signups)`).all();
    const phoneCol = cols.find(c => c.name === 'phone');
    if (phoneCol && phoneCol.notnull) {
      const hasLastLogin = cols.some(c => c.name === 'last_login');

      db.pragma('foreign_keys = OFF');
      db.exec('DROP TABLE IF EXISTS signups_v2');

      let createSql = `CREATE TABLE signups_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT,
        nid TEXT,
        name TEXT,
        username TEXT,
        email TEXT,
        island TEXT,
        contribution_type TEXT,
        donation_amount REAL DEFAULT 0,
        initial_merit_estimate INTEGER DEFAULT 0,
        is_verified INTEGER DEFAULT 1,
        auth_token TEXT,
        unregistered_at TEXT,
        unregistered_by TEXT,
        unregister_justification TEXT,
        timestamp TEXT NOT NULL`;
      if (hasLastLogin) createSql += ',\n        last_login TEXT';
      createSql += '\n      )';
      db.exec(createSql);

      let insertSql = `INSERT INTO signups_v2 (id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp`;
      let selectSql = `SELECT id, phone, nid, name, username, email, island, contribution_type, donation_amount, initial_merit_estimate, is_verified, auth_token, unregistered_at, unregistered_by, unregister_justification, timestamp`;
      if (hasLastLogin) {
        insertSql += ', last_login)';
        selectSql += ', last_login';
      } else {
        insertSql += ')';
      }
      selectSql += ' FROM signups';
      db.exec(insertSql + ' ' + selectSql);

      db.exec('DROP TABLE signups');
      db.exec('ALTER TABLE signups_v2 RENAME TO signups');

      db.pragma('foreign_keys = ON');

      console.log('✓ Migration: Made phone and nid nullable in signups');
    } else {
      console.log('✓ Phone/NID already nullable');
    }
  } catch (e) {
    console.log('⚠ Phone/NID nullable migration error:', e.message);
  }

  // Referrals table - track who introduced whom
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      details TEXT,
      base_reward_given INTEGER DEFAULT 0,
      engagement_bonus_given INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      referred_joined_at TEXT,
      first_action_at TEXT,
      FOREIGN KEY (referrer_id) REFERENCES signups(id),
      FOREIGN KEY (referred_id) REFERENCES signups(id)
    )
  `);

  // Migration: Add missing columns to referrals
  try {
    db.exec('ALTER TABLE referrals ADD COLUMN details TEXT');
  } catch (e) {}

  // System-wide activity log
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      user_id INTEGER,
      target_id INTEGER,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      timestamp TEXT NOT NULL
    )
  `);

  // Peer endorsements with diminishing returns
  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_endorsements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endorser_id INTEGER NOT NULL,
      endorsed_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(endorser_id, endorsed_id),
      FOREIGN KEY (endorser_id) REFERENCES signups(id),
      FOREIGN KEY (endorsed_id) REFERENCES signups(id)
    )
  `);

  try {
    db.exec('ALTER TABLE peer_endorsements ADD COLUMN expires_at TEXT');
  } catch (e) {}

  // Donations table (merit: 35 * log5(Donation_Value_USD + 1))
  db.exec(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount_usd REAL NOT NULL,
      amount_mvr REAL,
      merit_points_awarded REAL DEFAULT 0,
      source TEXT,
      verified INTEGER DEFAULT 0,
      donated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  // Bounty System
  db.exec(`
    CREATE TABLE IF NOT EXISTS bounties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      tier INTEGER NOT NULL CHECK(tier IN (1, 2, 3)),
      reward_points INTEGER NOT NULL,
      posted_by_user_id INTEGER,
      assigned_to_user_id INTEGER,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'completed', 'cancelled')),
      created_at TEXT NOT NULL,
      completed_at TEXT,
      proof_description TEXT,
      FOREIGN KEY (posted_by_user_id) REFERENCES signups(id),
      FOREIGN KEY (assigned_to_user_id) REFERENCES signups(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bounty_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      proof TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (bounty_id) REFERENCES bounties(id),
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  // Leadership Academy
  db.exec(`
    CREATE TABLE IF NOT EXISTS academy_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      order_index INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS academy_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module_id INTEGER NOT NULL,
      status TEXT DEFAULT 'enrolled' CHECK(status IN ('enrolled', 'in_progress', 'completed')),
      enrolled_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (module_id) REFERENCES academy_modules(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS academy_graduation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      graduated_at TEXT NOT NULL,
      merit_awarded REAL DEFAULT 0,
      mentor_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (mentor_id) REFERENCES signups(id)
    )
  `);

  // Initialize default academy modules if empty
  const existingModules = db.prepare('SELECT COUNT(*) as cnt FROM academy_modules').get();
  if (existingModules.cnt === 0) {
    const now = new Date().toISOString();
    const modules = [
      { title: 'Public Finance & Budgeting', description: 'Learn the fundamentals of public finance management, budget planning, and fiscal responsibility in governance.' },
      { title: 'Legislative Drafting and Analysis', description: 'Master the art of writing clear, effective legislation that withstands legal scrutiny.' },
      { title: 'Media Training & Strategic Communication', description: 'Develop skills for effective public communication, press relations, and message framing.' },
      { title: 'Parliamentary Procedure', description: 'Understand the rules and conventions of parliamentary decision-making.' },
      { title: 'Policy Analysis & Research', description: 'Learn to research, evaluate, and formulate evidence-based policies.' },
    ];
    modules.forEach((m, i) => {
      db.prepare('INSERT INTO academy_modules (title, description, order_index, created_at) VALUES (?, ?, ?, ?)').run(m.title, m.description, i, now);
    });
  }

  // ==================== ROLE-BASED STIPENDS ====================
  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_stipends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      position_id INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      amount_awarded REAL NOT NULL,
      awarded_at TEXT NOT NULL,
      UNIQUE(user_id, position_id, period_year, period_month),
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (position_id) REFERENCES leadership_positions(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS advisory_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      report_title TEXT NOT NULL,
      report_content TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  // Public wall posts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS wall_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      message TEXT NOT NULL,
      is_approved INTEGER DEFAULT 1,
      timestamp TEXT NOT NULL
    )
  `);

  // Migration: Add is_approved column to existing wall_posts table
  try {
    db.exec(`ALTER TABLE wall_posts ADD COLUMN is_approved INTEGER DEFAULT 1`);
  } catch (e) {}

  // Migration: Add thread_id column for grouping related posts
  try {
    db.exec(`ALTER TABLE wall_posts ADD COLUMN thread_id TEXT`);
  } catch (e) {}

  // Migration: Wall 2.0
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN parent_id INTEGER`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN user_id INTEGER`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN user_name TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN upvotes INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN downvotes INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN score REAL DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN is_flagged INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN flagged_by_ip TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN flag_reason TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN is_hidden INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE wall_posts ADD COLUMN reply_count INTEGER DEFAULT 0`); } catch (e) {}

  // Wall vote tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS wall_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER,
      ip_address TEXT,
      vote INTEGER NOT NULL CHECK(vote IN (-1, 0, 1)),
      created_at TEXT NOT NULL,
      FOREIGN KEY (post_id) REFERENCES wall_posts(id)
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS wall_votes_unique ON wall_votes(post_id, COALESCE(user_id, -1), COALESCE(ip_address, 'anon'))`); } catch (e) {}

  // Wall flag/report tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS wall_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      reporter_id INTEGER,
      reporter_ip TEXT,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      resolved_by INTEGER,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (post_id) REFERENCES wall_posts(id)
    )
  `);

  // Policy proposals table
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_by_nickname TEXT,
      status TEXT DEFAULT 'active',
      yes_votes INTEGER DEFAULT 0,
      no_votes INTEGER DEFAULT 0,
      abstain_votes INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      ends_at TEXT NOT NULL
    )
  `);

  // ==================== MERIT SYSTEM ====================
  db.exec(`
    CREATE TABLE IF NOT EXISTS merit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      points REAL NOT NULL,
      reference_id INTEGER,
      reference_type TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  // Migration: Add user_id to votes table if not exists
  try {
    db.exec('ALTER TABLE votes ADD COLUMN user_id INTEGER');
  } catch (e) {}

  // Migration: Add weighted_vote columns
  try {
    db.exec('ALTER TABLE votes ADD COLUMN vote_weight REAL DEFAULT 1.0');
    db.exec('ALTER TABLE votes ADD COLUMN loyalty_coefficient REAL DEFAULT 1.0');
    db.exec('ALTER TABLE votes ADD COLUMN days_since_created INTEGER DEFAULT 0');
  } catch (e) {}

  // Migration: Add category column to proposals
  try {
    db.exec('ALTER TABLE proposals ADD COLUMN approval_threshold REAL');
  } catch (e) {}

  // Migration: Add is_closed and passed columns to proposals
  try {
    db.exec('ALTER TABLE proposals ADD COLUMN is_closed INTEGER DEFAULT 0');
    db.exec('ALTER TABLE proposals ADD COLUMN passed INTEGER DEFAULT 0');
  } catch (e) {}

  // Migration: Add amendment support to proposals
  try {
    db.exec('ALTER TABLE proposals ADD COLUMN amendment_of INTEGER');
    db.exec('ALTER TABLE proposals ADD COLUMN original_yes_votes INTEGER DEFAULT 0');
    db.exec('ALTER TABLE proposals ADD COLUMN original_no_votes INTEGER DEFAULT 0');
  } catch (e) {}

  // Ranked choice proposals
  db.exec(`
    CREATE TABLE IF NOT EXISTS ranked_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'election',
      options TEXT NOT NULL,
      created_by_nickname TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      ends_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ranked_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL,
      ranking TEXT NOT NULL,
      voter_ip TEXT,
      voted_at TEXT NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES ranked_proposals(id)
    )
  `);

  try {
    db.exec('ALTER TABLE ranked_votes ADD COLUMN user_id INTEGER');
  } catch (e) {}

  // Laws/Regulations
  db.exec(`
    CREATE TABLE IF NOT EXISTS laws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'policy',
      source_proposal_id INTEGER,
      status TEXT DEFAULT 'proposed',
      passed_at TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    )
  `);

  // Migrate database schema if needed
  try {
    const tableInfo = db.prepare('PRAGMA table_info(signups)').all();
    const columns = tableInfo.map(col => col.name);

    const requiredColumns = {
      'auth_token': 'TEXT',
      'unregistered_at': 'TEXT',
      'unregistered_by': 'TEXT',
      'unregister_justification': 'TEXT'
    };

    for (const [column, type] of Object.entries(requiredColumns)) {
      if (!columns.includes(column)) {
        db.exec(`ALTER TABLE signups ADD COLUMN ${column} ${type}`);
        console.log(`✓ Added ${column} column to signups table`);
      }
    }
  } catch (error) {
    console.log('⚠ Database migration error:', error.message);
  }

  console.log('✓ SQLite database initialized for 3d Party');

  // Law votes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS law_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      vote TEXT NOT NULL CHECK(vote IN ('support', 'oppose', 'abstain')),
      reasoning TEXT,
      voted_at TEXT NOT NULL,
      user_ip TEXT,
      user_phone TEXT
    )
  `);

  // ==================== EVENTS TABLE ====================
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      event_date TEXT NOT NULL,
      location TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // ==================== DONATIONS TABLE ====================
  db.exec(`
    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      phone TEXT,
      nid TEXT,
      amount REAL NOT NULL,
      slip_filename TEXT,
      remarks TEXT,
      status TEXT DEFAULT 'pending',
      verified_by TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id)
    )
  `);

  try {
    db.exec(`ALTER TABLE donations ADD COLUMN remarks TEXT`);
  } catch (e) {}

  // Migration: Make phone and nid nullable in donations table
  try {
    const donationCols = db.prepare(`PRAGMA table_info(donations)`).all();
    const phoneColDonations = donationCols.find(c => c.name === 'phone');
    if (phoneColDonations && phoneColDonations.notnull) {
      const existingRows = donationCols.map(c => c.name);
      const hasUserId = existingRows.includes('user_id');
      const hasNid = existingRows.includes('nid');
      const hasRemarks = existingRows.includes('remarks');
      const hasVerifiedBy = existingRows.includes('verified_by');
      const hasVerifiedAt = existingRows.includes('verified_at');

      db.exec('DROP TABLE IF EXISTS donations_v2');

      let createSql = `CREATE TABLE donations_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        phone TEXT,
        nid TEXT,
        amount REAL NOT NULL,
        slip_filename TEXT,
        remarks TEXT,
        status TEXT DEFAULT 'pending',
        verified_by TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL`;
      createSql += '\n    )';

      let insertCols = ['id', 'amount', 'slip_filename', 'status', 'created_at'];
      let selectCols = ['id', 'amount', 'slip_filename', 'status', 'created_at'];
      if (hasUserId) { insertCols.push('user_id'); selectCols.push('user_id'); }
      if (hasNid) { insertCols.push('nid'); selectCols.push('nid'); }
      if (hasRemarks) { insertCols.push('remarks'); selectCols.push('remarks'); }
      if (hasVerifiedBy) { insertCols.push('verified_by'); selectCols.push('verified_by'); }
      if (hasVerifiedAt) { insertCols.push('verified_at'); selectCols.push('verified_at'); }
      insertCols.push('phone');
      selectCols.push('phone');

      const insertSql = `INSERT INTO donations_v2 (${insertCols.join(', ')}) SELECT ${selectCols.join(', ')} FROM donations`;
      db.exec(createSql);
      db.exec(insertSql);
      db.exec('DROP TABLE donations');
      db.exec('ALTER TABLE donations_v2 RENAME TO donations');
      console.log('✓ Migration: Made phone/nid nullable in donations table');
    } else {
      console.log('✓ Donations phone/nid already nullable');
    }
  } catch (e) {
    console.log('⚠ Donations phone/nid nullable migration error:', e.message);
  }

  // ==================== LIVE TREASURY LEDGER ====================
  db.exec(`
    CREATE TABLE IF NOT EXISTS treasury_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('donation', 'expenditure')),
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      source_ref_type TEXT,
      source_ref_id INTEGER,
      donor_nickname TEXT,
      verified_by TEXT,
      status TEXT DEFAULT 'verified' CHECK(status IN ('pending', 'verified', 'rejected')),
      created_at TEXT NOT NULL,
      verified_at TEXT
    )
  `);

  // Add category/donor_nickname/verified_by columns if not exists
  try {
    const ledgerCols = db.prepare(`PRAGMA table_info(treasury_ledger)`).all();
    if (!ledgerCols.find(c => c.name === 'category')) {
      db.exec(`ALTER TABLE treasury_ledger ADD COLUMN category TEXT`);
    }
    if (!ledgerCols.find(c => c.name === 'donor_nickname')) {
      db.exec(`ALTER TABLE treasury_ledger ADD COLUMN donor_nickname TEXT`);
    }
    if (!ledgerCols.find(c => c.name === 'verified_by')) {
      db.exec(`ALTER TABLE treasury_ledger ADD COLUMN verified_by TEXT`);
    }
  } catch (e) {}

  // Retroactive migration: populate treasury_ledger from existing data
  try {
    const ledgerCount = db.prepare('SELECT COUNT(*) as c FROM treasury_ledger').get();
    if (ledgerCount.c === 0) {
      const now = new Date().toISOString();
      const verifiedDonations = db.prepare(`SELECT * FROM donations WHERE status = 'verified'`).all();
      for (const d of verifiedDonations) {
        const donor = d.user_id ? db.prepare('SELECT name, username FROM signups WHERE id = ?').get(d.user_id) : null;
        const nickname = donor ? (donor.username || donor.name || 'Donor #' + (d.user_id || 'anon')) : 'Anonymous';
        db.prepare(`INSERT INTO treasury_ledger (type, amount, description, category, source_ref_type, source_ref_id, donor_nickname, verified_by, status, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('donation', d.amount, 'Verified donation', 'donation', 'donation', d.id, nickname, d.verified_by || 'admin', 'verified', d.created_at || now, d.verified_at || now);
      }
      const signupDonors = db.prepare(`SELECT id, name, username, donation_amount, timestamp FROM signups WHERE donation_amount > 0`).all();
      for (const s of signupDonors) {
        const nickname = s.username || s.name || 'Member #' + s.id;
        db.prepare(`INSERT INTO treasury_ledger (type, amount, description, category, source_ref_type, source_ref_id, donor_nickname, verified_by, status, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('donation', s.donation_amount, 'Signup donation', 'donation', 'signup', s.id, nickname, 'system', 'verified', s.timestamp || now, s.timestamp || now);
      }
      console.log(`✓ Migrated ${verifiedDonations.length + signupDonors.length} transactions to treasury_ledger`);
    }
  } catch (e) {
    console.log('⚠ Treasury ledger migration note:', e.message);
  }

  // ==================== LEADERSHIP STRUCTURE TABLES ====================
  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_settings (
      id INTEGER PRIMARY KEY,
      member_threshold INTEGER DEFAULT 1000,
      min_merit_for_leadership INTEGER DEFAULT 500,
      max_term_years INTEGER DEFAULT 2,
      appraisal_frequency_days INTEGER DEFAULT 365,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const existingSettings = db.prepare('SELECT id FROM leadership_settings').get();
  if (!existingSettings) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO leadership_settings (id, member_threshold, min_merit_for_leadership, max_term_years, appraisal_frequency_days, created_at, updated_at) VALUES (1, 1000, 500, 2, 365, ?, ?)').run(now, now);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      position_type TEXT NOT NULL CHECK(position_type IN ('council', 'committee', 'hub', 'advisory', 'emeritus')),
      min_merit_required INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);

  const existingPositions = db.prepare('SELECT COUNT(*) as cnt FROM leadership_positions').get();
  if (existingPositions.cnt === 0) {
    const now = new Date().toISOString();
    const positions = [
      { title: 'Shadow President', description: 'Leader of the Governing Council', type: 'council', min_merit: 1000 },
      { title: 'Shadow Finance Minister', description: 'Oversees treasury and budgets', type: 'council', min_merit: 800 },
      { title: 'Shadow Foreign Minister', description: 'External relations and outreach', type: 'council', min_merit: 800 },
      { title: 'Shadow Education Minister', description: 'Policy and planning for education', type: 'council', min_merit: 800 },
      { title: 'Shadow Health Minister', description: 'Healthcare policy and planning', type: 'council', min_merit: 800 },
      { title: 'Integrity Committee Chair', description: 'Leads ethics and conduct investigations', type: 'committee', min_merit: 600 },
      { title: 'Verification Committee Chair', description: 'Manages member verification', type: 'committee', min_merit: 500 },
      { title: 'Policy Hub Lead', description: 'Coordinates Policy Incubation Hubs', type: 'hub', min_merit: 700 },
    ];
    const insertStmt = db.prepare('INSERT INTO leadership_positions (title, description, position_type, min_merit_required, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)');
    positions.forEach(p => insertStmt.run(p.title, p.description, p.type, p.min_merit, now));
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      position_id INTEGER NOT NULL,
      application_text TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'interview', 'approved', 'rejected')),
      merit_score_at_apply INTEGER NOT NULL,
      interview_scheduled_at TEXT,
      interview_video_url TEXT,
      interview_notes TEXT,
      applied_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (position_id) REFERENCES leadership_positions(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      position_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      term_number INTEGER DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES signups(id),
      FOREIGN KEY (position_id) REFERENCES leadership_positions(id)
    )
  `);

  // Performance appraisals
  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_appraisals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL,
      appraisal_period TEXT NOT NULL,
      rating INTEGER CHECK(rating BETWEEN 1 AND 5),
      strengths TEXT,
      areas_for_improvement TEXT,
      overall_feedback TEXT,
      appraisal_by_user_id INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (term_id) REFERENCES leadership_terms(id)
    )
  `);

  // Standard Operating Procedures (SOPs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS leadership_sops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      version INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const existingSOPs = db.prepare('SELECT COUNT(*) as cnt FROM leadership_sops').get();
  if (existingSOPs.cnt === 0) {
    const now = new Date().toISOString();
    const sops = [
      { title: 'Daily Management Duties', content: 'Leadership must: 1) Respond to member queries within 24 hours. 2) Review and process pending proposals. 3) Update dashboard with current status. 4) Attend scheduled council meetings. 5) Document all decisions in Decision Statements.', category: 'operations' },
      { title: 'Meeting Protocol', content: 'All leadership meetings: 1) Must have published agenda 24h in advance. 2) Quorum required (50%+1). 3) Minutes published within 48h. 4) Decisions require documented vote count.', category: 'governance' },
      { title: 'Financial Oversight', content: 'Treasury management: 1) All expenditures over 1% budget require public vote. 2) Monthly financial reports published. 3) Independent audit annually. 4) Donation sources publicly logged.', category: 'finance' },
      { title: 'Conflict Resolution', content: 'Disputes handled by: 1) Initial mediation within 7 days. 2) Committee review if unresolved. 3) Full council vote for serious issues. 4) All decisions documented and published.', category: 'governance' },
      { title: 'Recall Process', content: 'Leadership recall: 1) Requires petition of 10% members. 2) Super-majority (80%) vote to remove. 3) Immediate suspension during process. 4) Right to appeal within 14 days.', category: 'accountability' },
    ];
    const insertSOP = db.prepare('INSERT INTO leadership_sops (title, content, category, version, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)');
    sops.forEach(s => insertSOP.run(s.title, s.content, s.category, now, now));
  }

  // System settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id INTEGER PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const existingSystemSettings = db.prepare('SELECT id FROM system_settings WHERE id = 1').get();
  if (!existingSystemSettings) {
    db.prepare('INSERT INTO system_settings (id, settings_json, updated_at) VALUES (1, ?, ?)')
      .run(JSON.stringify(DEFAULT_SETTINGS), new Date().toISOString());
  }

  console.log('✓ Leadership structure tables initialized');

  // ==================== ADD DEMO DATA ====================
  const demoProposals = db.prepare('SELECT COUNT(*) as cnt FROM proposals').get();
  if (demoProposals.cnt === 0) {
    const now = new Date().toISOString();
    const futureDate = new Date(Date.now() + getSettings().proposal_voting_days * 24 * 60 * 60 * 1000).toISOString();

    const demoData = [
      { title: 'Establish Free Public Wi-Fi in All Islands', description: 'Provide free internet access to all inhabited islands in Maldives, starting with the most underserved regions. This will help bridge the digital divide and enable remote education and work opportunities.', category: 'infrastructure' },
      { title: 'Ban Single-Use Plastics by 2025', description: 'Phase out all single-use plastic bags, bottles, and packaging by December 2025. Replace with biodegradable alternatives. Exceptions for medical and essential uses.', category: 'environment' },
      { title: 'Mandatory Financial Literacy Education', description: 'Introduce financial literacy as a mandatory subject in secondary schools. Topics: budgeting, saving, investing, loans, and avoiding predatory lending.', category: 'education' },
      { title: 'Remote Work Visa for Digital Nomads', description: 'Create a special visa category for remote workers and digital nomads, allowing them to live in Maldives for 6-12 months while working for foreign employers.', category: 'economy' },
      { title: 'Protect Coral Reefs with AI Monitoring', description: 'Deploy AI-powered monitoring systems to track coral reef health in real-time. Automatic alerts for bleaching events, illegal fishing, and pollution. Immediate response teams.', category: 'environment' }
    ];

    const insertProp = db.prepare('INSERT INTO proposals (title, description, category, created_by_nickname, status, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    demoData.forEach(d => {
      insertProp.run(d.title, d.description, d.category, 'DemoBot', 'active', now, futureDate);
    });
    console.log('✓ Demo proposals added');
  }

  const demoWallPosts = db.prepare('SELECT COUNT(*) as cnt FROM wall_posts').get();
  if (demoWallPosts.cnt === 0) {
    const now = new Date().toISOString();

    const demoPosts = [
      { nickname: 'Aisha from Fuvahmulah', message: 'Just joined! Excited to be part of building a better Maldives. The merit system is so fair — finally a party where everyone has a voice!' },
      { nickname: 'Mohamed from Male', message: 'The live treasury idea is brilliant. Knowing exactly where every rufiyaa goes builds so much trust. Already donated 500 MVR!' },
      { nickname: 'Fathimath from Addu', message: 'Can we propose a law to fix the garbage collection in Addu? The current system really needs an upgrade.' },
      { nickname: 'Ali from Kulhudhuffushi', message: 'Love the 3% goal! Told 5 friends today. If we each bring 5 people, we hit 13,000 in no time 🚀' },
      { nickname: 'Hassan from Thinadhoo', message: 'The whitepaper is incredible. Finally a political party that explains everything transparently. No more hidden agendas!' }
    ];

    const insertPost = db.prepare('INSERT INTO wall_posts (nickname, message, timestamp) VALUES (?, ?, ?)');
    demoPosts.forEach(p => {
      insertPost.run(p.nickname, p.message, now);
    });
    console.log('✓ Demo wall posts added');
  }

  // Migration: Add password_hash to signups for password-based login
  try {
    db.exec('ALTER TABLE signups ADD COLUMN password_hash TEXT');
    console.log('✓ Migration: Added password_hash to signups');
  } catch (e) {}

  // Migration: Add created_by_user_id to proposals
  try {
    db.exec('ALTER TABLE proposals ADD COLUMN created_by_user_id INTEGER REFERENCES signups(id)');
    console.log('✓ Migration: Added created_by_user_id to proposals');
  } catch (e) {}

  // Migration: Add created_by_user_id to ranked_proposals
  try {
    db.exec('ALTER TABLE ranked_proposals ADD COLUMN created_by_user_id INTEGER REFERENCES signups(id)');
    console.log('✓ Migration: Added created_by_user_id to ranked_proposals');
  } catch (e) {}
}

module.exports = { runMigrations };