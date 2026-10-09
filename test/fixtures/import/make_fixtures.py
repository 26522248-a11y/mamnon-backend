"""Builds hand-made .xlsx fixtures that mimic the package structure of other spreadsheet tools
(no Google Sheets / Microsoft Excel available on the build box):

  ok_gsheets_like.xlsx - like a Google Sheets "Download > .xlsx": no docProps / theme, shared strings,
                         dates typed as real dates (serial + numFmt), phones typed as numbers (leading 0 lost),
                         <sheetPr><outlinePr>, defaultColWidth 12.63, header in row 1.
  ok_excel_like.xlsx   - like Microsoft Excel 365: mc:Ignorable x14ac/xr namespaces + xr:uid attributes,
                         theme, docProps, calcChain, dates as serial with numFmtId 14, phones as text (t="s").
  ok_inlinestr_text.xlsx - t="inlineStr" cells only (no sharedStrings part), dates as dd/mm/yyyy text.

Same 2 children as ok_openpyxl.xlsx. Run: python3 make_fixtures.py
"""
import zipfile
from xml.sax.saxutils import escape

HEAD = ['Họ tên bé *', 'Ngày sinh *', 'Giới tính *', 'Lớp *', 'Dị ứng', 'Ghi chú sức khỏe', 'Địa chỉ', 'Ngày nhập học',
        'PH1 - Họ tên *', 'PH1 - Quan hệ', 'PH1 - SĐT *', 'PH1 - Được đón', 'PH2 - Họ tên', 'PH2 - Quan hệ', 'PH2 - SĐT', 'PH2 - Được đón']
# ('d', serial) = date cell, ('n', x) = number, str = string
ROWS_G = [
    ['QA Nhập Một', ('d', 44621), 'Nam', 'Mầm 1', None, None, None, None, 'QA Bố Một', 'Bố', ('n', 987000001), 'Có'],
    ['QA Nhập Hai', ('d', 44653), 'Nữ', 'Mầm 1', 'Sữa', None, None, None, 'QA Mẹ Hai', 'Mẹ', ('n', 987000002), 'Có', 'QA Bà Hai', 'Bà', ('n', 987000003), 'Không'],
]
ROWS_X = [
    ['QA Nhập Một', ('d', 44621), 'Nam', 'Mầm 1', None, None, None, None, 'QA Bố Một', 'Bố', '0987000001', 'Có'],
    ['QA Nhập Hai', ('d', 44653), 'Nữ', 'Mầm 1', 'Sữa', None, None, None, 'QA Mẹ Hai', 'Mẹ', '0987000002', 'Có', 'QA Bà Hai', 'Bà', '0987000003', 'Không'],
]

def col(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s

def sheet_xml(rows, excel, inline=False):
    sst, idx = [], {}
    def si(t):
        if t not in idx: idx[t] = len(sst); sst.append(t)
        return idx[t]
    out = []
    for r, vals in enumerate([HEAD] + rows, start=1):
        cells = []
        for c, v in enumerate(vals):
            if v is None: continue
            ref = f'{col(c)}{r}'
            if isinstance(v, tuple):
                kind, x = v
                cells.append(f'<c r="{ref}" s="1"><v>{x}</v></c>' if kind == 'd' else f'<c r="{ref}"><v>{x}</v></c>')
            elif inline:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(v)}</t></is></c>')
            else:
                cells.append(f'<c r="{ref}" t="s"><v>{si(v)}</v></c>')
        uid = f' x14ac:dyDescent="0.25"' if excel else ''
        out.append(f'<row r="{r}" spans="1:16"{uid}>' + ''.join(cells) + '</row>')
    if excel:
        ws = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
              'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" '
              'xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" '
              'xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" '
              'xr:uid="{00000000-0001-0000-0000-000000000000}"><dimension ref="A1:P3"/><sheetViews><sheetView tabSelected="1" workbookViewId="0">'
              '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
              '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><sheetData>' + ''.join(out) +
              '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
    else:
        ws = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
              '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
              '<sheetPr><outlinePr summaryBelow="0" summaryRight="0"/></sheetPr><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
              '<sheetFormatPr customHeight="1" defaultColWidth="12.63" defaultRowHeight="15.75"/><sheetData>' + ''.join(out) + '</sheetData></worksheet>')
    sstx = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(sst)}" uniqueCount="{len(sst)}">'
            + ''.join(f'<si><t>{escape(t)}</t></si>' for t in sst) + '</sst>')
    return ws, sstx

STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>'
          '<fonts count="1"><font><sz val="10"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
          '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
          '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="{NF}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
          '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
CT_HEAD = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
           '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
           '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
           '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
           '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
           '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def build(name, rows, excel, inline=False):
    ws, sst = sheet_xml(rows, excel, inline)
    with zipfile.ZipFile(name, 'w', zipfile.ZIP_DEFLATED) as z:
        ct = CT_HEAD.replace('<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>', '') if inline else CT_HEAD
        if excel:
            ct += ('<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
                   '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>'
                   '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
                   '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>')
        z.writestr('[Content_Types].xml', ct + '</Types>')
        rels = f'<Relationship Id="rId1" Type="{R}/officeDocument" Target="xl/workbook.xml"/>'
        if excel:
            rels += ('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
                     f'<Relationship Id="rId3" Type="{R}/extended-properties" Target="docProps/app.xml"/>')
            z.writestr('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>QA</dc:creator></cp:coreProperties>')
            z.writestr('docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>')
            z.writestr('xl/theme/theme1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>')
            z.writestr('xl/calcChain.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="Q2" i="1"/></calcChain>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>')
        wb_ns = (' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6" xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2"' if excel else '')
        z.writestr('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                   f'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="{R}"{wb_ns}>'
                   + ('<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/>' if excel else '<workbookPr/>')
                   + '<bookViews><workbookView/></bookViews><sheets><sheet name="Học sinh" sheetId="1" r:id="rId1"/></sheets>'
                   + ('<calcPr calcId="191029"/>' if excel else '<definedNames/><calcPr/>') + '</workbook>')
        wrels = (f'<Relationship Id="rId1" Type="{R}/worksheet" Target="worksheets/sheet1.xml"/>'
                 + ('' if inline else f'<Relationship Id="rId2" Type="{R}/sharedStrings" Target="sharedStrings.xml"/>') +
                 f'<Relationship Id="rId3" Type="{R}/styles" Target="styles.xml"/>')
        if excel:
            wrels += f'<Relationship Id="rId4" Type="{R}/theme" Target="theme/theme1.xml"/><Relationship Id="rId5" Type="{R}/calcChain" Target="calcChain.xml"/>'
        z.writestr('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + wrels + '</Relationships>')
        z.writestr('xl/styles.xml', STYLES.replace('{NF}', '14' if excel else '164'))
        if not inline: z.writestr('xl/sharedStrings.xml', sst)
        z.writestr('xl/worksheets/sheet1.xml', ws)

build('ok_gsheets_like.xlsx', ROWS_G, False)
build('ok_excel_like.xlsx', ROWS_X, True)
# true t="inlineStr" cells (no sharedStrings part at all), dates typed as text
ROWS_I = [[('01/03/2022' if i == 1 and r[0] == 'QA Nhập Một' else '02/04/2022' if i == 1 else v) for i, v in enumerate(r)] for r in ROWS_X]
build('ok_inlinestr_text.xlsx', ROWS_I, False, inline=True)
