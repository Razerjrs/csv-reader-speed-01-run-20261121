// solve.js — a faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. The semantics, checked against the reference
// (baselines/csv-reader/vendor/csv-reader/index.js):
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based line
//     its record starts on (every LF, CRLF and lone CR inside quotes counted),
//     row its record's index in rows (null for the header).
//
// Speed: one pass over the text with charCodeAt, one slice per field instead of
// per-character concatenation, indexOf to jump to the next quote, and a
// piecewise rebuild only for the rare fields that need one (a stray CR, a line
// break or a doubled quote inside quotes). Nothing is kept from one call to the
// next; every case is answered alone.

/** How a field ended: at a comma (the record goes on), at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let quoted = false;

    while (true) {
      let fval;
      let fend;
      // The unquoted scan below runs from `start` with `head` already kept; a
      // plain field starts it at pos with no head, a field whose quote never
      // closed restarts it just past the quote with head '"', and the junk
      // after a closing quote runs it with the quoted value as head.
      let head = '';
      let start = pos;
      let scanUnquoted = true;
      let junk = false;

      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        // Find the closing quote; a quote followed by another quote is doubled.
        let q = open + 1;
        let close = -1;
        let dpos = null; // positions of doubled quotes, when any
        while (true) {
          const i = text.indexOf('"', q);
          if (i === -1) break;
          if (text.charCodeAt(i + 1) === 34) {
            if (dpos === null) dpos = [];
            dpos.push(i);
            q = i + 2;
            continue;
          }
          close = i;
          break;
        }

        if (close === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          head = '"';
          start = open + 1;
        } else {
          // The quoted content is [open + 1, close).
          let value;
          const nlAt = text.indexOf('\n', open + 1);
          const hasNL = nlAt !== -1 && nlAt < close;
          const crAt = text.indexOf('\r', open + 1);
          const hasCR = crAt !== -1 && crAt < close;
          if (!hasNL && !hasCR) {
            if (dpos === null) {
              value = text.slice(open + 1, close);
            } else {
              const pieces = [];
              let s = open + 1;
              for (let k = 0; k < dpos.length; k++) {
                pieces.push(text.slice(s, dpos[k]));
                pieces.push('"');
                s = dpos[k] + 2;
              }
              pieces.push(text.slice(s, close));
              value = pieces.join('');
            }
          } else {
            // Line breaks and doubled quotes inside: rebuild, each CRLF or
            // lone CR read as one LF, and count every line break.
            const pieces = [];
            let s = open + 1;
            let i = open + 1;
            while (i < close) {
              const c = text.charCodeAt(i);
              if (c === 34) {
                pieces.push(text.slice(s, i));
                pieces.push('"');
                i += 2;
                s = i;
              } else if (c === 13) {
                pieces.push(text.slice(s, i));
                pieces.push('\n');
                line += 1;
                i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
                s = i;
              } else if (c === 10) {
                pieces.push(text.slice(s, i));
                pieces.push('\n');
                line += 1;
                i += 1;
                s = i;
              } else {
                i += 1;
              }
            }
            pieces.push(text.slice(s, close));
            value = pieces.join('');
          }

          pos = close + 1;
          if (pos >= n) {
            fval = value;
            fend = END;
            scanUnquoted = false;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fval = value;
              fend = COMMA;
              scanUnquoted = false;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fval = value;
              fend = LINE_BREAK;
              scanUnquoted = false;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fval = value;
              fend = LINE_BREAK;
              scanUnquoted = false;
            } else {
              // What follows the closing quote is appended as it stands.
              head = value;
              start = pos;
              junk = true;
            }
          }
        }
      } else {
        quoted = false;
      }

      if (scanUnquoted) {
        // Read unquoted characters onto `head` up to the next comma or line
        // break: a CR not followed by LF is dropped (stray_cr). One slice
        // when nothing was dropped, pieces joined when a stray CR was.
        const scanStart = start;
        let p = start;
        let dropped = 0;
        let parts = null;
        while (p < n) {
          const c = text.charCodeAt(p);
          if (c === 44 || c === 10) break;
          if (c === 13) {
            if (text.charCodeAt(p + 1) === 10) break;
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (parts === null) parts = [head, text.slice(start, p)];
            else parts.push(text.slice(start, p));
            head = '';
            dropped += 1;
            p += 1;
            start = p;
            continue;
          }
          p += 1;
        }
        const added = p - scanStart - dropped;
        if (parts === null) fval = head === '' ? text.slice(start, p) : head + text.slice(start, p);
        else {
          parts.push(text.slice(start, p));
          fval = parts.join('');
        }
        if (junk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        if (p >= n) {
          pos = p;
          fend = END;
        } else {
          const c = text.charCodeAt(p);
          if (c === 44) {
            pos = p + 1;
            fend = COMMA;
          } else if (c === 10) {
            pos = p + 1;
            line += 1;
            fend = LINE_BREAK;
          } else {
            pos = p + 2;
            line += 1;
            fend = LINE_BREAK;
          }
        }
      }

      fields.push(fval);
      if (fend !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
