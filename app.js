const express = require('express');
const http = require('http');
const path = require('path');
const compression = require('compression');
const fs = require('fs');
const { Server } = require('socket.io');
const session = require('express-session');
const flash = require('connect-flash');
const SQLiteStore = require('connect-sqlite3')(session);

// Config setup
const confFile = path.join(__dirname, 'config', 'config.json');
const confDefaults = require('./config/default.json');

fs.mkdirSync(path.dirname(confFile), { recursive: true });

if (!fs.existsSync(confFile)) {
  fs.writeFileSync(confFile, JSON.stringify(confDefaults, null, 2));
  console.log('Created config file:', confFile);
}

const nconf = require('nconf');
nconf.file({ file: confFile });
nconf.load();

// Environment overrides for managed Node.js hosting.
if (process.env.PORT) {
  const hostingPort = Number(process.env.PORT);
  if (!Number.isInteger(hostingPort) || hostingPort < 1 || hostingPort > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  nconf.set('server:port', hostingPort);
}
if (process.env.SESSION_SECRET) {
  nconf.set('sessionSecret', process.env.SESSION_SECRET);
}
if (process.env.INGEST_API_KEY) {
  nconf.set('ingest:apiKey', process.env.INGEST_API_KEY);
}
if (process.env.CAD_MODE) {
  if (!['standalone', 'connected'].includes(process.env.CAD_MODE)) {
    throw new Error('CAD_MODE must be standalone or connected');
  }
  nconf.set('mode', process.env.CAD_MODE);
}

// The session store opens before db.init creates this directory.
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

// Initialize Express first (db.init is async, called later)
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Make io available to routes
app.set('io', io);

// View engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, 'data')
  }),
  secret: nconf.get('sessionSecret') || 'cad-dispatch-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Flash messages
app.use(flash());

// Passport authentication
const { passport, ensureAuthenticated } = require('./middleware/auth');
app.use(passport.initialize());
app.use(passport.session());

// Make user available to all views
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  next();
});

// Make nconf available to routes
app.use((req, res, next) => {
  req.nconf = nconf;
  next();
});

// Routes
const cadRoutes = require('./routes/cad');
const mapRoutes = require('./routes/map');
const ingestRoutes = require('./routes/ingest');
const settingsRoutes = require('./routes/settings');
const authRoutes = require('./routes/auth');
const archiveRoutes = require('./routes/archive');

// Auth routes (login/logout - not protected)
app.use('/auth', authRoutes);

// Protected routes - require authentication
app.use('/cad', ensureAuthenticated, cadRoutes);
app.use('/cad/archive', ensureAuthenticated, archiveRoutes);
app.use('/map', ensureAuthenticated, mapRoutes);
app.use('/settings', ensureAuthenticated, settingsRoutes);

// Ingest route - not protected (receives messages from PagerMon)
app.use('/ingest', ingestRoutes);

// Home redirect
app.get('/', (req, res) => {
  res.redirect('/cad');
});

// Socket.IO handling
io.on('connection', (socket) => {
  console.log('CAD client connected:', socket.id);
  
  socket.on('join', (room) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined room: ${room}`);
  });
  
  socket.on('disconnect', () => {
    console.log('CAD client disconnected:', socket.id);
  });
});

// Mode detection
const mode = nconf.get('mode') || 'standalone';
console.log(`Running in ${mode.toUpperCase()} mode`);

// Initialize PagerMon socket connection (only in connected mode)
const pagermonSocket = require('./services/pagermonSocket');
const caseManager = require('./services/caseManager');

if (mode === 'connected') {
  // Connected mode: Direct connection to PagerMon
  pagermonSocket.init(io);
  
  setTimeout(async () => {
    console.log('Initial sync from PagerMon database...');
    try {
      await caseManager.syncFromPagermon();
    } catch (error) {
      console.error('Initial sync failed:', error.message);
    }
  }, 3000);
} else {
  // Standalone mode: Receives messages via /ingest endpoint
  console.log('Standalone mode - waiting for messages via /ingest/message endpoint');
  console.log('Configure PagerMon Message Repeat plugin to send to: http://YOUR_SERVER:3001/ingest/message');
}

// Periodic cleanup - runs every 5 minutes to close old cases based on timeout settings
setInterval(() => {
  caseManager.closeOldCases();
}, 5 * 60 * 1000);

// Run once on startup after a short delay
setTimeout(() => {
  caseManager.closeOldCases();
}, 10000);

// Error handling
app.use((req, res, next) => {
  res.status(404).render('cad/error', {
    pageTitle: 'Not Found',
    message: 'Page not found'
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('cad/error', {
    pageTitle: 'Error',
    message: 'Internal server error'
  });
});

// Start server with async initialization
const port = nconf.get('server:port') || 3001;

async function startServer() {
  // Initialize database (async for sql.js)
  const db = require('./db');
  await db.init();
  
  // Fix existing cases that may have incorrect service detection
  console.log('Checking for cases that need service/prefix fixes...');
  db.fixCaseServiceFromPrefix();
  
  server.listen(port, () => {
    console.log('='.repeat(50));
    console.log('PagerMon CAD Add-on');
    console.log('='.repeat(50));
    console.log(`Server running on http://localhost:${port}`);
    console.log(`CAD Board: http://localhost:${port}/cad`);
    console.log(`Live Map:  http://localhost:${port}/map`);
    console.log('='.repeat(50));
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
