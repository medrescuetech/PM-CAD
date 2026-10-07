const express = require('express');
const router = express.Router();
const nconf = require('nconf');
const moment = require('moment');
const caseManager = require('../services/caseManager');
const db = require('../db');
const { ensureCanEdit, ensureAdmin } = require('../middleware/auth');
const pdfGenerator = require('../services/pdfGenerator');

// CAD Board - Main view
router.get('/', (req, res) => {
  const services = nconf.get('services') || {};
  const serviceFilter = req.query.service || null;
  const timeRange = req.query.range || 'active';
  const customStart = req.query.start || null;
  const customEnd = req.query.end || null;
  
  let cases;
  let startDate = '';
  let endDate = '';
  
  if (timeRange === 'active') {
    // Default: active cases only
    cases = caseManager.getActiveCasesByService(serviceFilter);
  } else if (timeRange === 'custom' && customStart && customEnd) {
    // Custom date range
    const start = new Date(customStart);
    const end = new Date(customEnd);
    cases = caseManager.getCasesByDateRange(start, end, serviceFilter);
    startDate = customStart;
    endDate = customEnd;
  } else {
    // Quick range (1h, 4h, 12h, 24h, 48h, 7d)
    const rangeMap = {
      '1h': 1,
      '4h': 4,
      '12h': 12,
      '24h': 24,
      '48h': 48,
      '7d': 168
    };
    const hours = rangeMap[timeRange] || 4;
    const start = new Date(Date.now() - hours * 60 * 60 * 1000);
    const end = new Date();
    cases = caseManager.getCasesByDateRange(start, end, serviceFilter);
  }
  
  // Group cases by service
  const casesByService = {};
  for (const [key, config] of Object.entries(services)) {
    casesByService[key] = {
      config,
      cases: cases.filter(c => c.service === key)
    };
  }
  
  // Add unknown service if any
  const unknownCases = cases.filter(c => c.service === 'unknown');
  if (unknownCases.length > 0) {
    casesByService['unknown'] = {
      config: { name: 'Unknown', color: '#6c757d', icon: 'question' },
      cases: unknownCases
    };
  }
  
  res.render('cad/index', {
    pageTitle: 'CAD Board',
    services,
    casesByService,
    serviceFilter,
    totalCases: cases.length,
    timeRange,
    startDate,
    endDate,
    moment
  });
});

// Priority cases view
router.get('/priority', (req, res) => {
  const services = nconf.get('services') || {};
  const cases = caseManager.getPriorityCases();
  
  res.render('cad/priority', {
    pageTitle: 'Priority Cases - CAD',
    services,
    cases,
    moment
  });
});

// Messages view (non-case messages like group pages, info, etc.)
router.get('/messages', (req, res) => {
  const services = nconf.get('services') || {};
  const serviceFilter = req.query.service || null;
  const limit = parseInt(req.query.limit) || 100;
  
  const messages = db.getMessages(limit, serviceFilter);
  
  res.render('cad/messages', {
    pageTitle: 'Messages - CAD',
    services,
    messages,
    serviceFilter,
    moment
  });
});

// Single service view
router.get('/service/:service', (req, res) => {
  const services = nconf.get('services') || {};
  const serviceKey = req.params.service;
  const serviceConfig = services[serviceKey] || { name: serviceKey, color: '#6c757d', icon: 'question' };
  
  const cases = caseManager.getActiveCasesByService(serviceKey);
  
  res.render('cad/service', {
    pageTitle: `${serviceConfig.name} - CAD`,
    service: serviceKey,
    serviceConfig,
    cases,
    moment
  });
});

// Case detail view
router.get('/case/:caseNumber', (req, res) => {
  const caseNumber = req.params.caseNumber;
  const caseDetails = caseManager.getCaseWithDetails(caseNumber);
  
  if (!caseDetails) {
    return res.status(404).render('cad/error', {
      pageTitle: 'Case Not Found',
      message: `Case ${caseNumber} not found`
    });
  }
  
  const services = nconf.get('services') || {};
  
  res.render('cad/case', {
    pageTitle: `Case ${caseNumber}`,
    case: caseDetails,
    services,
    moment
  });
});

// API: Get active cases
router.get('/api/cases', (req, res) => {
  const serviceFilter = req.query.service || null;
  const cases = caseManager.getActiveCasesByService(serviceFilter);
  res.json(cases);
});

// API: Get single case
router.get('/api/case/:caseNumber', (req, res) => {
  const caseDetails = caseManager.getCaseWithDetails(req.params.caseNumber);
  
  if (!caseDetails) {
    return res.status(404).json({ error: 'Case not found' });
  }
  
  res.json(caseDetails);
});

// API: Get cases for map
router.get('/api/map-cases', (req, res) => {
  const serviceFilter = req.query.service || null;
  const cases = caseManager.getCasesForMap(serviceFilter);
  res.json(cases);
});

// API: Mark/unmark case as major incident (requires operator or admin)
router.post('/api/case/:caseNumber/major', ensureCanEdit, (req, res) => {
  const caseNumber = req.params.caseNumber;
  const isMajor = req.body.major === true || req.body.major === 'true';
  
  db.setMajorIncident(caseNumber, isMajor);
  
  res.json({ success: true, caseNumber, isMajor });
});

// API: Close/disable a major incident (requires operator or admin)
router.post('/api/case/:caseNumber/close', ensureCanEdit, (req, res) => {
  const caseNumber = req.params.caseNumber;
  
  db.closeCase(caseNumber);
  
  res.json({ success: true, caseNumber, status: 'closed' });
});

// Major incidents view
router.get('/major', (req, res) => {
  const services = nconf.get('services') || {};
  const majorCases = db.getMajorIncidents();
  const escalatedCases = db.getEscalatedIncidents();
  
  // Combine and dedupe (major incidents may also be escalated)
  const allCases = [...majorCases];
  for (const c of escalatedCases) {
    if (!allCases.find(m => m.case_number === c.case_number)) {
      allCases.push(c);
    }
  }
  
  res.render('cad/major', {
    pageTitle: 'Major Incidents - CAD',
    services,
    majorCases,
    escalatedCases: allCases,
    moment
  });
});

// API: Add note to case (requires operator or admin)
router.post('/api/case/:caseNumber/note', ensureCanEdit, (req, res) => {
  try {
    const { caseNumber } = req.params;
    const { note } = req.body;
    // Use logged-in user's name as author
    const author = req.user ? (req.user.display_name || req.user.username) : null;
    
    if (!note || note.trim() === '') {
      return res.status(400).json({ error: 'Note text is required' });
    }
    
    const caseRecord = db.getCaseByNumber(caseNumber);
    if (!caseRecord) {
      return res.status(404).json({ error: 'Case not found' });
    }
    
    const result = db.addCaseNote(caseRecord.id, note.trim(), author);
    console.log(`Note added to case ${caseNumber} by ${author || 'anonymous'}`);
    res.json({ success: true, timestamp: result.timestamp });
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

// API: Get notes for case
router.get('/api/case/:caseNumber/notes', (req, res) => {
  try {
    const { caseNumber } = req.params;
    const caseRecord = db.getCaseByNumber(caseNumber);
    if (!caseRecord) {
      return res.status(404).json({ error: 'Case not found' });
    }
    
    const notes = db.getCaseNotes(caseRecord.id);
    res.json({ success: true, notes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Sync from PagerMon
router.post('/api/sync', async (req, res) => {
  try {
    const hoursBack = parseInt(req.query.hours) || 4;
    const result = await caseManager.syncFromPagermon(hoursBack);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Sync specific date range from PagerMon
router.post('/api/sync-range', async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    const result = await caseManager.syncDateRange(startDate, endDate);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get cases by date range
router.get('/api/cases-range', (req, res) => {
  try {
    const { startDate, endDate, service } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate query params are required' });
    }
    
    const cases = caseManager.getCasesByDateRange(startDate, endDate, service || null);
    res.json(cases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Historical view - browse cases by date
router.get('/history', (req, res) => {
  const services = nconf.get('services') || {};
  const serviceFilter = req.query.service || null;
  const startDate = req.query.startDate || moment().subtract(24, 'hours').format('YYYY-MM-DDTHH:mm');
  const endDate = req.query.endDate || moment().format('YYYY-MM-DDTHH:mm');
  
  const cases = caseManager.getCasesByDateRange(startDate, endDate, serviceFilter);
  
  // Group cases by service
  const casesByService = {};
  for (const [key, config] of Object.entries(services)) {
    casesByService[key] = {
      config,
      cases: cases.filter(c => c.service === key)
    };
  }
  
  res.render('cad/history', {
    pageTitle: 'Case History',
    services,
    casesByService,
    serviceFilter,
    startDate,
    endDate,
    totalCases: cases.length,
    moment
  });
});

// API: Close old cases
router.post('/api/close-old', (req, res) => {
  try {
    const closed = caseManager.closeOldCases();
    res.json({ success: true, closed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PDF: Generate dispatch slip
router.get('/case/:caseNumber/print/dispatch', async (req, res) => {
  try {
    const caseNumber = req.params.caseNumber;
    const caseDetails = caseManager.getCaseWithDetails(caseNumber);
    
    if (!caseDetails) {
      return res.status(404).send('Case not found');
    }
    
    // Get the most recent message for the dispatch slip
    const messages = caseDetails.messages || [];
    const latestMessage = messages.length > 0 ? messages[messages.length - 1].message : '';
    
    const pdfBuffer = await pdfGenerator.generateDispatchSlip(caseDetails, latestMessage);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dispatch-${caseNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating dispatch PDF:', error);
    res.status(500).send('Error generating PDF');
  }
});

// PDF: Generate full case log
router.get('/case/:caseNumber/print/log', async (req, res) => {
  try {
    const caseNumber = req.params.caseNumber;
    const caseDetails = caseManager.getCaseWithDetails(caseNumber);
    
    if (!caseDetails) {
      return res.status(404).send('Case not found');
    }
    
    const pdfBuffer = await pdfGenerator.generateCaseLog(caseDetails);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="caselog-${caseNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating case log PDF:', error);
    res.status(500).send('Error generating PDF');
  }
});

module.exports = router;
