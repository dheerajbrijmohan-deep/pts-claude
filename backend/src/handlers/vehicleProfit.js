const ExcelJS = require('exceljs');
const { sendJson } = require('../lib/http');
const { computeVehicleProfit } = require('../lib/vehicleProfit');

async function summary(req, res, params, query) {
  const { from, to } = query;
  const vehicleId = params.id;
  if (!from || !to) return sendJson(res, 400, { error: 'from and to are required' });
  try {
    const result = await computeVehicleProfit(vehicleId, from, to);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: err.message });
  }
}

async function exportXlsx(req, res, params, query) {
  const { from, to } = query;
  const vehicleId = params.id;
  if (!from || !to) return sendJson(res, 400, { error: 'from and to are required' });
  let result;
  try {
    result = await computeVehicleProfit(vehicleId, from, to);
  } catch (err) {
    return sendJson(res, err.statusCode || 500, { error: err.message });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fleet Command';
  const sheet = workbook.addWorksheet(('Vehicle ' + result.vehicle.regNo).slice(0, 31));

  const fuelTypeKeys = Object.keys(result.totals.fuelByType);
  sheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Driver', key: 'driver', width: 16 },
    { header: 'Start Reading', key: 'startReading', width: 14 },
    { header: 'End Reading', key: 'endReading', width: 14 },
    { header: 'Total Run (km)', key: 'totalRun', width: 14 },
    ...fuelTypeKeys.map((t) => ({ header: 'Fuel: ' + t, key: 'fuel_' + t, width: 14 })),
    { header: 'Fuel Total', key: 'fuelTotal', width: 12 },
    { header: 'Total Earning', key: 'totalEarning', width: 14 },
    { header: 'Driver Earning', key: 'driverSalary', width: 14 },
    { header: result.isJiju ? 'To Jiju' : 'EMI (daily share)', key: 'overhead', width: 16 },
    { header: 'Maintenance (manual)', key: 'maintenanceManual', width: 16 },
    { header: 'Maintenance (logged)', key: 'maintenanceLogged', width: 16 },
    { header: 'Expense Claims', key: 'supplies', width: 14 },
    { header: 'Total Cost', key: 'cost', width: 12 },
    { header: 'Profit', key: 'profit', width: 12 },
  ];

  result.rows.forEach((r) => {
    const rowData = { ...r };
    fuelTypeKeys.forEach((t) => {
      rowData['fuel_' + t] = r.fuelLines
        .filter((l) => (l.fuelType ? l.fuelType.charAt(0).toUpperCase() + l.fuelType.slice(1) : 'Other') === t)
        .reduce((s, l) => s + (Number(l.amount) || 0), 0);
    });
    sheet.addRow(rowData);
  });

  const totalRow = {
    date: 'TOTAL', totalRun: result.totals.totalRun, fuelTotal: result.totals.fuelTotal,
    totalEarning: result.totals.totalEarning, driverSalary: result.totals.driverSalary,
    overhead: result.totals.overhead, maintenanceManual: result.totals.maintenanceManual,
    maintenanceLogged: result.totals.maintenanceLogged, supplies: result.totals.supplies,
    cost: result.totals.totalCost, profit: result.totals.profit,
  };
  fuelTypeKeys.forEach((t) => { totalRow['fuel_' + t] = result.totals.fuelByType[t]; });
  const addedTotalRow = sheet.addRow(totalRow);
  addedTotalRow.font = { bold: true };
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8DCC8' } };

  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="vehicle_${result.vehicle.regNo}_profit_${from}_to_${to}.xlsx"`,
  });
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { summary, exportXlsx };
