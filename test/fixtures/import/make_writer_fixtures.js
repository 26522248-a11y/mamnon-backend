/**
 * Fixtures written by the two common JS writers, each with shared vs inline strings and dates as serial vs text:
 *   exceljs_sst_serial.xlsx, exceljs_inline_text.xlsx, sheetjs_sst_serial.xlsx, sheetjs_inline_text.xlsx
 * SheetJS writes inline text as t="str" and Date as a local-time serial (fractional when TZ != UTC) – both kept on purpose.
 * Same 2 children as ok_openpyxl.xlsx (dates 01/03/2022, 02/04/2022; phones as text).
 * Run from the repo root:  SHEETJS=/path/to/node_modules/xlsx node test/fixtures/import/make_writer_fixtures.js
 * (SheetJS is NOT an app dependency; install it anywhere, e.g. npm i --prefix /tmp/sheetjs https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)
 */
const path = require('path');
const ExcelJS = require('exceljs');
const XLSX = require(process.env.SHEETJS || 'xlsx');
const out = (f) => path.join(__dirname, f);

const HEAD = ['Họ tên bé *', 'Ngày sinh *', 'Giới tính *', 'Lớp *', 'Dị ứng', 'Ghi chú sức khỏe', 'Địa chỉ', 'Ngày nhập học',
  'PH1 - Họ tên *', 'PH1 - Quan hệ', 'PH1 - SĐT *', 'PH1 - Được đón', 'PH2 - Họ tên', 'PH2 - Quan hệ', 'PH2 - SĐT', 'PH2 - Được đón'];
const rows = (serial) => {
  const d = (y, m, day) => (serial ? new Date(Date.UTC(y, m - 1, day)) : `${String(day).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`);
  return [
    ['QA Nhập Một', d(2022, 3, 1), 'Nam', 'Mầm 1', null, null, null, null, 'QA Bố Một', 'Bố', '0987000001', 'Có', null, null, null, null],
    ['QA Nhập Hai', d(2022, 4, 2), 'Nữ', 'Mầm 1', 'Sữa', null, null, null, 'QA Mẹ Hai', 'Mẹ', '0987000002', 'Có', 'QA Bà Hai', 'Bà', '0987000003', 'Không'],
  ];
};

async function exceljs(file, serial, useSharedStrings) {
  // streaming writer: the only exceljs writer that honours useSharedStrings=false (-> t="inlineStr" cells)
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: out(file), useSharedStrings, useStyles: true });
  const ws = wb.addWorksheet('Học sinh');
  if (serial) ws.getColumn(2).numFmt = 'dd/mm/yyyy';
  ws.addRow(HEAD).commit();
  for (const r of rows(serial)) ws.addRow(r).commit();
  ws.commit();
  await wb.commit();
}
function sheetjs(file, serial, bookSST) {
  const ws = XLSX.utils.aoa_to_sheet([HEAD, ...rows(serial)], { cellDates: false, dateNF: 'dd/mm/yyyy' }); // Date -> serial number + date format
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Học sinh');
  XLSX.writeFile(wb, out(file), { bookType: 'xlsx', bookSST, cellDates: false, compression: true });
}

(async () => {
  await exceljs('exceljs_sst_serial.xlsx', true, true);
  await exceljs('exceljs_inline_text.xlsx', false, false);
  sheetjs('sheetjs_sst_serial.xlsx', true, true);
  sheetjs('sheetjs_inline_text.xlsx', false, false);
})();
