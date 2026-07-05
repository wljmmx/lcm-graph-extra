/**
 * PDF 导出工具。
 *
 * 两种生成方式（自动检测）：
 * 1. pandoc：系统有 pandoc 时使用（高质量，支持完整 markdown 语法）
 * 2. 纯 JS fallback：无外部依赖，生成简单可读的 PDF
 *
 * 输出路径：~/.openclaw/reports/
 */

import { execFile } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface PdfExportResult {
  ok: boolean;
  path?: string;
  format: 'pdf' | 'markdown';
  method?: 'pandoc' | 'fallback';
  error?: string;
}

let _pandocChecked = false;
let _pandocAvailable = false;

function checkPandoc(): boolean {
  if (_pandocChecked) return _pandocAvailable;
  _pandocChecked = true;
  try {
    execFile('pandoc', ['--version'], { timeout: 2000 }, (err) => {
      _pandocAvailable = !err;
    });
  } catch {
    _pandocAvailable = false;
  }
  return _pandocAvailable;
}

export function isPandocAvailable(): boolean {
  return _pandocAvailable;
}

function ensureReportsDir(): string {
  const dir = join(homedir(), '.openclaw', 'reports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function generateTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function exportWithPandoc(markdown: string, filename: string): Promise<PdfExportResult> {
  const dir = ensureReportsDir();
  const mdPath = join(dir, `${filename}.md`);
  const pdfPath = join(dir, `${filename}.pdf`);
  writeFileSync(mdPath, markdown, 'utf8');

  return new Promise((resolveResult) => {
    const child = execFile(
      'pandoc',
      [mdPath, '-o', pdfPath, '--pdf-engine=xelatex', '-V', 'mainfont=Noto Sans CJK SC', '-V', 'geometry:margin=1in'],
      { timeout: 60_000 },
      (err) => {
        if (err) {
          try { unlinkSync(mdPath); } catch { /* ignore */ }
          resolveResult({
            ok: false,
            format: 'pdf',
            method: 'pandoc',
            error: `pandoc 转换失败: ${err.message}`,
          });
        } else {
          try { unlinkSync(mdPath); } catch { /* ignore */ }
          resolveResult({
            ok: true,
            path: pdfPath,
            format: 'pdf',
            method: 'pandoc',
          });
        }
      },
    );
    child.on('error', () => {
      resolveResult({
        ok: false,
        format: 'pdf',
        method: 'pandoc',
        error: 'pandoc 执行失败',
      });
    });
  });
}

function exportFallbackPdf(markdown: string, filename: string): PdfExportResult {
  const dir = ensureReportsDir();
  const pdfPath = join(dir, `${filename}.pdf`);

  const lines = markdown.split('\n');
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 40;
  const fontSize = 10;
  const lineHeight = 14;
  const contentWidth = pageWidth - margin * 2;
  const charsPerLine = Math.floor(contentWidth / (fontSize * 0.6));

  const wrappedLines: string[] = [];
  for (const line of lines) {
    if (line.length <= charsPerLine) {
      wrappedLines.push(line);
    } else {
      let remaining = line;
      while (remaining.length > 0) {
        wrappedLines.push(remaining.slice(0, charsPerLine));
        remaining = remaining.slice(charsPerLine);
      }
    }
  }

  const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight);
  const totalPages = Math.max(1, Math.ceil(wrappedLines.length / linesPerPage));

  let pdfContent = '';
  const pageObjects: string[] = [];

  for (let page = 0; page < totalPages; page++) {
    const pageLines = wrappedLines.slice(page * linesPerPage, (page + 1) * linesPerPage);
    let textStream = 'BT\n';
    textStream += `/F1 ${fontSize} Tf\n`;
    textStream += `${margin} ${pageHeight - margin} TD\n`;
    for (let i = 0; i < pageLines.length; i++) {
      if (i > 0) {
        textStream += `0 -${lineHeight} Td\n`;
      }
      const escaped = pageLines[i].replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      textStream += `(${escaped}) Tj\n`;
    }
    textStream += 'ET\n';
    const stream = `<< /Length ${textStream.length} >>\nstream\n${textStream}endstream\n`;
    pageObjects.push(stream);
  }

  let pdf = '%PDF-1.4\n';
  let offset = pdf.length;
  const offsets: number[] = [];

  pdf += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  offsets.push(offset);
  offset = pdf.length;

  const pageObjNums: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    pageObjNums.push(4 + i * 2);
  }
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');

  pdf += `2 0 obj\n<< /Type /Pages /Count ${totalPages} /Kids [${kids}] >>\nendobj\n`;
  offsets.push(offset);
  offset = pdf.length;

  pdf += '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  offsets.push(offset);
  offset = pdf.length;

  for (let i = 0; i < totalPages; i++) {
    const contentObjNum = 5 + i * 2;
    pdf += `${4 + i * 2} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`;
    offsets.push(offset);
    offset = pdf.length;

    pdf += `${contentObjNum} 0 obj\n${pageObjects[i]}endobj\n`;
    offsets.push(offset);
    offset = pdf.length;
  }

  const xrefOffset = offset;
  pdf += `xref\n0 ${offsets.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  writeFileSync(pdfPath, pdf, 'binary');

  return {
    ok: true,
    path: pdfPath,
    format: 'pdf',
    method: 'fallback',
  };
}

export async function exportMarkdownToPdf(
  markdown: string,
  baseFilename?: string,
): Promise<PdfExportResult> {
  const ts = generateTimestamp();
  const filename = baseFilename ? `${baseFilename}-${ts}` : `report-${ts}`;

  checkPandoc();

  if (_pandocAvailable) {
    try {
      const result = await exportWithPandoc(markdown, filename);
      if (result.ok) return result;
    } catch {
      // fall through to fallback
    }
  }

  return exportFallbackPdf(markdown, filename);
}

export function exportMarkdownToFile(
  markdown: string,
  baseFilename?: string,
): { ok: boolean; path: string; format: 'markdown' } {
  const dir = ensureReportsDir();
  const ts = generateTimestamp();
  const filename = baseFilename ? `${baseFilename}-${ts}.md` : `report-${ts}.md`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, markdown, 'utf8');
  return { ok: true, path: filepath, format: 'markdown' };
}
