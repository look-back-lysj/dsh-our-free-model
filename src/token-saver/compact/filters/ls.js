/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a long directory listing: names, sizes, and a type summary.
 *
 * ## What a listing is for
 *
 * A model runs `ls -la` to learn what is in a directory. The columns it does not
 * need are the ones `-l` adds for human readers: permissions, link count, owner,
 * group, and the exact timestamp. What it does need is the name, whether the entry
 * is a directory or a file, roughly how big the file is, and what kinds of file
 * dominate.
 *
 * So the output is one line per entry (name and size), then a summary counting
 * files, directories and extensions. Noise directories are dropped entirely —
 * `node_modules` in a listing tells the model nothing it can act on and can be
 * thousands of rows.
 *
 * ## Parsing by the date column, not by column count
 *
 * `ls -l` output has a stable *shape* but not a stable *column count*: the owner
 * and group fields vary in width, and some platforms omit the group. The date
 * column is the one landmark with a fixed format, so the name is read as
 * "everything after the date" and the numeric fields are read from the part before
 * it. Splitting on whitespace from the left would break on a filename containing
 * spaces, which is common.
 *
 * @module src/token-saver/compact/filters/ls
 */

import { LS_EXT_SUMMARY_TOP, LS_NOISE_DIRS } from '../constants.js'

const NOISE = new Set(LS_NOISE_DIRS)

/** The `Mon DD HH:MM` or `Mon DD YYYY` column that separates metadata from name. */
const DATE_COLUMN = /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2})\s+/

/** Size rendered in the largest unit that keeps it readable. */
function humanSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${bytes}B`
}

export function ls(input) {
  let directoryRows = ''
  let fileRows = ''
  let directoryCount = 0
  let fileCount = 0
  const extensions = new Map()

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    // `total N` is the block-count header, not an entry; it has no date column
    // either, but naming it explicitly keeps the intent clear.
    const date = row.startsWith('total ') ? null : DATE_COLUMN.exec(row)
    if (date !== null) {
      const name = row.slice(date.index + date[0].length)
      const columns = row.slice(0, date.index).trim().split(/\s+/)
      // Four columns is the minimum for a permissions string, a link count, an
      // owner and a size; anything shorter is not an entry row.
      if (columns.length >= 4 && name !== '.' && name !== '..' && !NOISE.has(name)) {
        const type = columns[0][0]
        if (type === 'd') {
          directoryRows += `${name}/\n`
          directoryCount += 1
        } else if (type === '-' || type === 'l') {
          // The size is the last field that is a plain integer. Scanning from the
          // right tolerates an omitted group column.
          let bytes = 0
          for (let index = columns.length - 1; index >= 0; index -= 1) {
            const number = Number(columns[index])
            if (Number.isInteger(number) && String(number) === columns[index]) {
              bytes = number
              break
            }
          }
          fileRows += `${name}  ${humanSize(bytes)}\n`
          fileCount += 1
          const dot = name.lastIndexOf('.')
          // A leading dot means a hidden file, not an extension.
          const extension = dot > 0 ? name.slice(dot) : 'no ext'
          extensions.set(extension, (extensions.get(extension) ?? 0) + 1)
        }
      }
    }
    if (newline < 0) break
    offset = newline + 1
  }

  if (directoryCount === 0 && fileCount === 0) return input

  let summary = `\nSummary: ${fileCount} files, ${directoryCount} dirs`
  if (extensions.size > 0) {
    const ranked = [...extensions].sort((left, right) => right[1] - left[1])
    const labels = ranked.slice(0, LS_EXT_SUMMARY_TOP).map(([extension, count]) => `${count} ${extension}`)
    if (ranked.length > LS_EXT_SUMMARY_TOP) labels.push(`+${ranked.length - LS_EXT_SUMMARY_TOP} more`)
    summary += ` (${labels.join(', ')})`
  }
  return directoryRows + fileRows + summary
}

ls.filterName = 'ls'
