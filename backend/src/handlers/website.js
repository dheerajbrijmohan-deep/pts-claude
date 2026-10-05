// Public-facing endpoints hit by the ptsnagpur.in marketing site — a booking
// request from the Hero form and a general enquiry from the Contact form.
// Both still open WhatsApp on the client; this just gives the Boss/Manager a
// durable record inside the admin panel in case the WhatsApp chat is missed.
const { sendJson, readJsonBody } = require('../lib/http');
const db = require('../db');
const { notify } = require('../lib/notify');

function clip(value, max) {
  if (value == null) return null;
  return String(value).trim().slice(0, max) || null;
}

async function submitBooking(req, res) {
  const b = await readJsonBody(req);
  const pickupLocation = clip(b.pickupLocation, 255);
  const destination = clip(b.destination, 255);
  const customerName = clip(b.customerName, 150);
  const phoneNumber = clip(b.customerPhone, 30);
  if (!pickupLocation || !destination || !customerName || !phoneNumber) {
    return sendJson(res, 400, { error: 'Pickup, destination, name, and phone are required' });
  }
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      `INSERT INTO website_bookings (pickup_location, destination, travel_date, travel_time, passengers, customer_name, phone_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(pickupLocation, destination, clip(b.date, 20), clip(b.time, 20), b.passengers ? Number(b.passengers) : null, customerName, phoneNumber, now);
  await notify('reminder',`Website booking request from ${customerName} (${phoneNumber}): ${pickupLocation} → ${destination}`, {});
  sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
}

async function submitContact(req, res) {
  const b = await readJsonBody(req);
  const name = clip(b.name, 150);
  const message = clip(b.message, 5000);
  if (!name || !message) {
    return sendJson(res, 400, { error: 'Name and message are required' });
  }
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO website_contacts (name, email, message, created_at) VALUES (?, ?, ?, ?)')
    .run(name, clip(b.email, 150), message, now);
  await notify('reminder',`Website contact message from ${name}`, {});
  sendJson(res, 201, { ok: true, id: info.lastInsertRowid });
}

async function listBookings(req, res) {
  const rows = await db.prepare('SELECT * FROM website_bookings ORDER BY created_at DESC LIMIT 300').all();
  sendJson(res, 200, rows);
}

async function listContacts(req, res) {
  const rows = await db.prepare('SELECT * FROM website_contacts ORDER BY created_at DESC LIMIT 300').all();
  sendJson(res, 200, rows);
}

const LEAD_STATUSES = ['new', 'contacted', 'closed'];

async function setBookingStatus(req, res, params) {
  const b = await readJsonBody(req);
  if (!LEAD_STATUSES.includes(b.status)) return sendJson(res, 400, { error: 'Unknown status' });
  const existing = await db.prepare('SELECT id FROM website_bookings WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Not found' });
  await db.prepare('UPDATE website_bookings SET status = ? WHERE id = ?').run(b.status, params.id);
  sendJson(res, 200, { ok: true });
}

async function setContactStatus(req, res, params) {
  const b = await readJsonBody(req);
  if (!LEAD_STATUSES.includes(b.status)) return sendJson(res, 400, { error: 'Unknown status' });
  const existing = await db.prepare('SELECT id FROM website_contacts WHERE id = ?').get(params.id);
  if (!existing) return sendJson(res, 404, { error: 'Not found' });
  await db.prepare('UPDATE website_contacts SET status = ? WHERE id = ?').run(b.status, params.id);
  sendJson(res, 200, { ok: true });
}

module.exports = { submitBooking, submitContact, listBookings, listContacts, setBookingStatus, setContactStatus };
