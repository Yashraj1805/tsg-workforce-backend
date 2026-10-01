// Generic row-data -> .xlsx buffer, shared by the scheduled report emails (R15) and
// the on-demand export endpoint (R16) — one place that knows how to build a sheet.
const ExcelJS = require('exceljs');

async function buildExcelBuffer(sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName.slice(0, 31)); // Excel sheet-name length limit
  sheet.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || 18 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach(r => sheet.addRow(r));
  return wb.xlsx.writeBuffer();
}

module.exports = { buildExcelBuffer };
