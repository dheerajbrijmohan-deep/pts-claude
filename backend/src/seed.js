// Running this file is enough to create the database and all tables — db.js
// creates them on require if they don't exist yet. No demo/sample rows are
// inserted; add real drivers and vehicles from the app itself.
const db = require('./db');
db.ready.then(() => {
  console.log('Fleet Command database is ready.');
  process.exit(0);
}).catch((err) => {
  console.error('Failed to set up the database:', err);
  process.exit(1);
});
