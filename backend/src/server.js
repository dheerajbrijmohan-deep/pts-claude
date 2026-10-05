const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { PORT } = require('./config');
const { sendJson, parseCookies } = require('./lib/http');
const auth = require('./auth');
const driverAuth = require('./driverAuth');
const { ready: dbReady } = require('./db');

const authHandlers = require('./handlers/auth');
const drivers = require('./handlers/drivers');
const vehicles = require('./handlers/vehicles');
const documents = require('./handlers/documents');
const settings = require('./handlers/settings');
const driverPortal = require('./handlers/driverPortal');
const reports = require('./handlers/reports');
const adminOps = require('./handlers/adminOps');
const adminUsers = require('./handlers/adminUsers');
const commits = require('./handlers/commits');
const fines = require('./handlers/fines');
const advances = require('./handlers/advances');
const payroll = require('./handlers/payroll');
const maintenance = require('./handlers/maintenance');
const incidents = require('./handlers/incidents');
const notifications = require('./handlers/notifications');
const auditLogs = require('./handlers/auditLogs');
const analytics = require('./handlers/analytics');
const vehicleProfit = require('./handlers/vehicleProfit');
const website = require('./handlers/website');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
const DRIVER_DIR = path.join(FRONTEND_DIR, 'driver');
const ADMIN_DIR = FRONTEND_DIR;
const WEBSITE_DIR = path.join(__dirname, '..', '..', 'website');

// auth: 'admin' (default, boss or manager) | 'boss' (boss only) | 'driver' | 'either' | 'public'
const ROUTES = [
  { method: 'POST', pattern: /^\/api\/login$/, handler: authHandlers.login, auth: 'public' },
  { method: 'POST', pattern: /^\/api\/logout$/, handler: authHandlers.logout },
  { method: 'GET', pattern: /^\/api\/me$/, handler: authHandlers.me },

  { method: 'GET', pattern: /^\/api\/settings$/, handler: settings.getSettings },
  { method: 'POST', pattern: /^\/api\/settings\/change-password$/, handler: settings.changePassword },

  { method: 'GET', pattern: /^\/api\/admin-users$/, handler: adminUsers.list, auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/admin-users$/, handler: adminUsers.create, auth: 'boss' },
  { method: 'PUT', pattern: /^\/api\/admin-users\/(\d+)$/, handler: adminUsers.update, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/admin-users\/(\d+)\/reset-password$/, handler: adminUsers.resetPassword, params: ['id'], auth: 'boss' },

  { method: 'POST', pattern: /^\/api\/duty-logs\/(\d+)\/commit$/, handler: commits.commitDutyLog, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/duty-logs\/(\d+)\/uncommit$/, handler: commits.uncommitDutyLog, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/expense-claims\/(\d+)\/commit$/, handler: commits.commitExpenseClaim, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/expense-claims\/(\d+)\/uncommit$/, handler: commits.uncommitExpenseClaim, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/fuel-entries\/(\d+)\/commit$/, handler: commits.commitFuelEntry, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/fuel-entries\/(\d+)\/uncommit$/, handler: commits.uncommitFuelEntry, params: ['id'], auth: 'boss' },

  // ---- fines & damage recovery ----
  { method: 'GET', pattern: /^\/api\/fines$/, handler: fines.list },
  { method: 'POST', pattern: /^\/api\/fines$/, handler: fines.create },
  { method: 'PUT', pattern: /^\/api\/fines\/(\d+)$/, handler: fines.update, params: ['id'] },
  { method: 'PUT', pattern: /^\/api\/fines\/(\d+)\/status$/, handler: fines.setStatus, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/fines\/(\d+)$/, handler: fines.remove, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/fines\/(\d+)\/commit$/, handler: commits.commitFine, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/fines\/(\d+)\/uncommit$/, handler: commits.uncommitFine, params: ['id'], auth: 'boss' },

  // ---- advances (running ledger) ----
  { method: 'GET', pattern: /^\/api\/advances$/, handler: advances.list },
  { method: 'GET', pattern: /^\/api\/advances\/balance$/, handler: advances.balance },
  { method: 'POST', pattern: /^\/api\/advances$/, handler: advances.create },
  { method: 'PUT', pattern: /^\/api\/advances\/(\d+)$/, handler: advances.update, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/advances\/(\d+)$/, handler: advances.remove, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/advances\/(\d+)\/commit$/, handler: commits.commitAdvance, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/advances\/(\d+)\/uncommit$/, handler: commits.uncommitAdvance, params: ['id'], auth: 'boss' },

  // ---- payroll ----
  { method: 'GET', pattern: /^\/api\/payroll$/, handler: payroll.list },
  { method: 'GET', pattern: /^\/api\/payroll\/preview$/, handler: payroll.preview },
  { method: 'POST', pattern: /^\/api\/payroll$/, handler: payroll.create },
  { method: 'PUT', pattern: /^\/api\/payroll\/(\d+)$/, handler: payroll.update, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/payroll\/(\d+)\/mark-paid$/, handler: payroll.markPaid, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/payroll\/(\d+)$/, handler: payroll.remove, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/payroll\/(\d+)\/commit$/, handler: commits.commitPayrollRun, params: ['id'], auth: 'boss' },
  { method: 'POST', pattern: /^\/api\/payroll\/(\d+)\/uncommit$/, handler: commits.uncommitPayrollRun, params: ['id'], auth: 'boss' },

  // ---- maintenance ----
  { method: 'GET', pattern: /^\/api\/maintenance$/, handler: maintenance.list },
  { method: 'GET', pattern: /^\/api\/maintenance\/due-soon$/, handler: maintenance.dueSoon },
  { method: 'POST', pattern: /^\/api\/maintenance$/, handler: maintenance.create },
  { method: 'PUT', pattern: /^\/api\/maintenance\/(\d+)$/, handler: maintenance.update, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/maintenance\/(\d+)$/, handler: maintenance.remove, params: ['id'] },

  // ---- accidents & incidents ----
  { method: 'GET', pattern: /^\/api\/incidents$/, handler: incidents.list },
  { method: 'GET', pattern: /^\/api\/incidents\/(\d+)$/, handler: incidents.getOne, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/incidents$/, handler: incidents.create },
  { method: 'PUT', pattern: /^\/api\/incidents\/(\d+)$/, handler: incidents.update, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/incident-photos\/(\d+)\/file$/, handler: incidents.downloadPhoto, params: ['id'], auth: 'either' },
  { method: 'POST', pattern: /^\/api\/driver\/incidents$/, handler: incidents.createFromDriver, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/incidents$/, handler: incidents.listMyIncidents, auth: 'driver' },

  // ---- notifications ----
  { method: 'GET', pattern: /^\/api\/notifications$/, handler: notifications.list },
  { method: 'POST', pattern: /^\/api\/notifications\/(\d+)\/read$/, handler: notifications.markRead, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/notifications\/read-all$/, handler: notifications.markAllRead },

  // ---- audit logs (Boss only) ----
  { method: 'GET', pattern: /^\/api\/audit-logs$/, handler: auditLogs.list, auth: 'boss' },

  // ---- analytics ----
  { method: 'GET', pattern: /^\/api\/analytics$/, handler: analytics.run },

  { method: 'GET', pattern: /^\/api\/documents\/expiring$/, handler: documents.listExpiring },

  { method: 'GET', pattern: /^\/api\/drivers$/, handler: drivers.list },
  { method: 'POST', pattern: /^\/api\/drivers$/, handler: drivers.create },
  { method: 'GET', pattern: /^\/api\/drivers\/(\d+)$/, handler: drivers.getOne, params: ['id'] },
  { method: 'PUT', pattern: /^\/api\/drivers\/(\d+)$/, handler: drivers.update, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/drivers\/(\d+)$/, handler: drivers.remove, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/drivers\/(\d+)\/status$/, handler: drivers.changeStatus, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/drivers\/(\d+)\/documents$/, handler: documents.uploadDriverDoc, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/driver-documents\/(\d+)\/file$/, handler: documents.downloadDriverDoc, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/driver-documents\/(\d+)$/, handler: documents.removeDriverDoc, params: ['id'] },

  { method: 'GET', pattern: /^\/api\/vehicles$/, handler: vehicles.list },
  { method: 'POST', pattern: /^\/api\/vehicles$/, handler: vehicles.create },
  { method: 'GET', pattern: /^\/api\/vehicles\/(\d+)$/, handler: vehicles.getOne, params: ['id'] },
  { method: 'PUT', pattern: /^\/api\/vehicles\/(\d+)$/, handler: vehicles.update, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/vehicles\/(\d+)$/, handler: vehicles.remove, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/vehicles\/(\d+)\/profit$/, handler: vehicleProfit.summary, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/vehicles\/(\d+)\/profit\/export$/, handler: vehicleProfit.exportXlsx, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/vehicles\/(\d+)\/documents$/, handler: documents.uploadVehicleDoc, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/vehicle-documents\/(\d+)\/file$/, handler: documents.downloadVehicleDoc, params: ['id'] },
  { method: 'DELETE', pattern: /^\/api\/vehicle-documents\/(\d+)$/, handler: documents.removeVehicleDoc, params: ['id'] },

  // ---- admin ops for the driver PWA's data (Phase 2) ----
  { method: 'PUT', pattern: /^\/api\/drivers\/(\d+)\/pin$/, handler: adminOps.setDriverPin, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/drivers\/(\d+)\/duty-logs$/, handler: adminOps.listDutyLogsForDriver, params: ['id'] },
  { method: 'PUT', pattern: /^\/api\/drivers\/(\d+)\/duty-logs\/([\d-]+)\/earnings$/, handler: adminOps.setDutyLogEarnings, params: ['id', 'date'] },
  { method: 'POST', pattern: /^\/api\/drivers\/(\d+)\/duty-logs\/([\d-]+)\/fuel$/, handler: adminOps.addAdminFuelEntry, params: ['id', 'date'] },
  { method: 'DELETE', pattern: /^\/api\/duty-log-fuel\/(\d+)$/, handler: adminOps.deleteAdminFuelEntry, params: ['fuelId'] },
  { method: 'PUT', pattern: /^\/api\/duty-logs\/(\d+)\/reopen-decision$/, handler: adminOps.decideReopenRequest, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/expense-claims$/, handler: adminOps.listExpenseClaims },
  { method: 'PUT', pattern: /^\/api\/expense-claims\/(\d+)\/status$/, handler: adminOps.decideExpenseClaim, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/leave-requests$/, handler: adminOps.listLeaveRequests },
  { method: 'PUT', pattern: /^\/api\/leave-requests\/(\d+)\/status$/, handler: adminOps.decideLeaveRequest, params: ['id'] },
  { method: 'POST', pattern: /^\/api\/drivers\/(\d+)\/announcements$/, handler: adminOps.sendAnnouncement, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/drivers\/(\d+)\/announcements$/, handler: adminOps.listAnnouncementsForDriver, params: ['id'] },
  { method: 'GET', pattern: /^\/api\/locations\/live$/, handler: adminOps.listLiveLocations },
  { method: 'GET', pattern: /^\/api\/drivers\/(\d+)\/location-trail\/([\d-]+)$/, handler: adminOps.getLocationTrail, params: ['id', 'date'] },
  { method: 'GET', pattern: /^\/api\/driving-events$/, handler: adminOps.listDrivingEvents },
  { method: 'GET', pattern: /^\/api\/announcements$/, handler: adminOps.listAllAnnouncements },
  { method: 'GET', pattern: /^\/api\/reports\/entities$/, handler: reports.listEntities },
  { method: 'GET', pattern: /^\/api\/reports\/export$/, handler: reports.exportXlsx },
  { method: 'GET', pattern: /^\/api\/reports$/, handler: reports.run },

  // ---- public website (ptsnagpur.in) leads ----
  { method: 'POST', pattern: /^\/api\/website\/bookings$/, handler: website.submitBooking, auth: 'public' },
  { method: 'POST', pattern: /^\/api\/website\/contact$/, handler: website.submitContact, auth: 'public' },
  { method: 'GET', pattern: /^\/api\/website\/bookings$/, handler: website.listBookings },
  { method: 'GET', pattern: /^\/api\/website\/contact$/, handler: website.listContacts },
  { method: 'PUT', pattern: /^\/api\/website\/bookings\/(\d+)\/status$/, handler: website.setBookingStatus, params: ['id'] },
  { method: 'PUT', pattern: /^\/api\/website\/contact\/(\d+)\/status$/, handler: website.setContactStatus, params: ['id'] },

  // ---- driver portal (own session, phone + PIN) ----
  { method: 'POST', pattern: /^\/api\/driver\/login$/, handler: driverPortal.login, auth: 'public' },
  { method: 'POST', pattern: /^\/api\/driver\/logout$/, handler: driverPortal.logout, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/me$/, handler: driverPortal.me, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/change-pin$/, handler: driverPortal.changeMyPin, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/duty-log\/today$/, handler: driverPortal.getTodayLog, auth: 'driver' },
  { method: 'PUT', pattern: /^\/api\/driver\/duty-log\/today$/, handler: driverPortal.saveTodayLog, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/duty-log\/today\/fuel$/, handler: driverPortal.addFuelEntry, auth: 'driver' },
  { method: 'DELETE', pattern: /^\/api\/driver\/duty-log\/today\/fuel\/(\d+)$/, handler: driverPortal.deleteFuelEntry, params: ['fuelId'], auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/duty-log\/today\/check-in$/, handler: driverPortal.checkIn, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/duty-log\/today\/lunch-start$/, handler: driverPortal.startLunch, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/duty-log\/today\/lunch-end$/, handler: driverPortal.endLunch, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/duty-log\/today\/check-out$/, handler: driverPortal.checkOut, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/duty-logs$/, handler: driverPortal.listMyLogs, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/documents$/, handler: driverPortal.listMyDocuments, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/leave-requests$/, handler: driverPortal.createLeaveRequest, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/leave-requests$/, handler: driverPortal.listMyLeaveRequests, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/announcements$/, handler: driverPortal.listMyAnnouncements, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/announcements\/(\d+)\/ack$/, handler: driverPortal.ackAnnouncement, params: ['id'], auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/expense-claims$/, handler: driverPortal.createExpenseClaim, auth: 'driver' },
  { method: 'GET', pattern: /^\/api\/driver\/expense-claims$/, handler: driverPortal.listMyExpenseClaims, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/location$/, handler: driverPortal.addLocationPing, auth: 'driver' },
  { method: 'POST', pattern: /^\/api\/driver\/driving-events$/, handler: driverPortal.addDrivingEvent, auth: 'driver' },

  // ---- photo downloads shared by admin (any) and the owning driver ----
  { method: 'GET', pattern: /^\/api\/fuel-entries\/(\d+)\/pump-photo$/, handler: driverPortal.downloadFuelPumpPhoto, params: ['id'], auth: 'either' },
  { method: 'GET', pattern: /^\/api\/fuel-entries\/(\d+)\/odometer-photo$/, handler: driverPortal.downloadFuelOdometerPhoto, params: ['id'], auth: 'either' },
  { method: 'GET', pattern: /^\/api\/expense-claims\/(\d+)\/photo$/, handler: driverPortal.downloadExpensePhoto, params: ['id'], auth: 'either' },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

// Three separate static apps share one Node server/port so the whole domain
// (public marketing site, admin panel, driver PWA) can be deployed as a
// single cPanel Node.js app: "/" is the public ptsnagpur.in website, "/admin"
// is this app's own admin SPA (moved off root to make room for the website),
// and "/driver" is unchanged. The website is a real (if client-routed)
// multi-page app, so an unknown deep path there 404s instead of silently
// falling back to the homepage; the admin/driver SPAs still fall back to
// their index.html so their internal (in-app) client-side view state works.
function serveStatic(req, res, pathname) {
  const isDriverApp = pathname === '/driver' || pathname.startsWith('/driver/');
  const isAdminApp = pathname === '/admin' || pathname.startsWith('/admin/');
  const rootDir = isDriverApp ? DRIVER_DIR : isAdminApp ? ADMIN_DIR : WEBSITE_DIR;
  const prefix = isDriverApp ? '/driver' : isAdminApp ? '/admin' : '';
  let relative = pathname.slice(prefix.length).replace(/^\//, '');

  if (!isDriverApp && !isAdminApp && relative && !path.extname(relative)) {
    // Public site: bare paths like "/fleet" map to a client-routed SPA page.
    relative = relative.replace(/\/$/, '');
  }

  let filePath = path.join(rootDir, relative || 'index.html');
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (!isDriverApp && !isAdminApp && path.extname(relative || '')) {
      res.writeHead(404);
      return res.end('Not found');
    }
    filePath = path.join(rootDir, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('This app is not built/deployed yet.');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsed.pathname);

    if (!pathname.startsWith('/api/')) {
      return serveStatic(req, res, pathname);
    }

    let matchedRoute = null;
    let params = {};
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      matchedRoute = route;
      (route.params || []).forEach((name, i) => (params[name] = match[i + 1]));
      break;
    }
    if (!matchedRoute) return sendJson(res, 404, { error: 'Not found' });

    const authType = matchedRoute.auth || 'admin';
    if (authType !== 'public') {
      const cookies = parseCookies(req);
      if (authType === 'admin' || authType === 'boss') {
        const user = await auth.getSessionUser(cookies[auth.COOKIE_NAME]);
        if (!user) return sendJson(res, 401, { error: 'Not logged in' });
        if (authType === 'boss' && user.role !== 'boss') {
          return sendJson(res, 403, { error: 'Only the Boss can do that.' });
        }
        req.adminUser = user;
      } else if (authType === 'driver') {
        const driver = await driverAuth.getDriverForSession(cookies[driverAuth.COOKIE_NAME]);
        if (!driver) return sendJson(res, 401, { error: 'Not logged in' });
        req.driver = driver;
      } else if (authType === 'either') {
        const driver = await driverAuth.getDriverForSession(cookies[driverAuth.COOKIE_NAME]);
        const user = await auth.getSessionUser(cookies[auth.COOKIE_NAME]);
        if (!driver && !user) return sendJson(res, 401, { error: 'Not logged in' });
        req.driver = driver || null;
        req.adminUser = user || null;
      }
    }

    const query = Object.fromEntries(parsed.searchParams.entries());
    await matchedRoute.handler(req, res, params, query);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, err.statusCode || 500, { error: err.message || 'Internal server error' });
    }
  }
});

dbReady
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Public website at http://localhost:${PORT}/`);
      console.log(`PFMS admin panel at http://localhost:${PORT}/admin`);
      console.log(`Driver app at http://localhost:${PORT}/driver`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MySQL:', err.message);
    console.error('Make sure the MySQL server is running (see backend/mysql/) and backend/.env has the right MYSQL_* values.');
    process.exit(1);
  });
