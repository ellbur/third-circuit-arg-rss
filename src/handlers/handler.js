
'use strict';

import html from 'node-html-parser';
import xml2js from 'xml2js';

// The court retired the old ASP.NET listing (oralargument/ListArguments30.aspx)
// in favour of a static page. Reachable from www.ca3.uscourts.gov ->
// "Oral Argument Recordings - Audio Only" -> OralArg.html.
// OralArgContentsAll.html has the same shape but ~2000 rows, so stick to 30 days.
const LIST_URL = 'https://www2.ca3.uscourts.gov/OralArgContents30.html';

// The court is in Philadelphia and stamps the listing in its own local time,
// with no zone marker. Lambda runs in UTC, so the components have to be
// interpreted against Eastern explicitly rather than the runtime's zone.
const COURT_TZ = 'America/New_York';

const TZ_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: COURT_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

// How far ahead of UTC the court's clock is at a given instant (negative for
// Eastern). Derived by rendering the instant in that zone and reading the
// wall-clock back as if it were UTC.
function courtOffsetAt(date) {
  const p = {};
  for (const { type, value } of TZ_PARTS.formatToParts(date)) p[type] = value;
  const hour = parseInt(p.hour) % 24; // hour12:false renders midnight as 24
  return Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second) - date.getTime();
}

// Turn a wall-clock reading in the court's zone into a real instant. The offset
// depends on the instant we are solving for, so guess with the offset at the
// naive point and re-solve once -- that settles it except for the wall-clock
// times that DST skips or repeats, where either answer is defensible.
function courtTimeToDate(y, mo, d, h, mi, s) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let stamp = naive - courtOffsetAt(new Date(naive));
  const refined = naive - courtOffsetAt(new Date(stamp));
  if (refined !== stamp) stamp = refined;
  return new Date(stamp);
}

function last(a) {
  return a[a.length-1];
}

export const getRSS = async (event) => {
  // All log statements are written to CloudWatch
  console.info('received:', event);

  const resp = await fetch(LIST_URL);
  if (!resp.ok) {
    throw new Error(`${LIST_URL} returned ${resp.status} ${resp.statusText}`);
  }

  const outItems = [ ];
  const outDoc = {
    rss: {
      $: {
        version: "2.0"
      },
      channel: {
        title: "Third Circuit Oral Arguments",
        link: LIST_URL,
        description: "Third Circuit oral arguments",
        item: outItems
      }
    }
  };

  const body = html.parse(await resp.text());
  // The rows live in a plain unnamed <table>; the header row uses <th>, so
  // matching on "exactly two <td>" is enough to pick out the argument rows.
  for (const tr of body.querySelectorAll('tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length == 2) {
      const td1 = tds[0];
      const td2 = tds[1];
      const a = td1.querySelector('a');
      const href = a.attributes['href'];
      // File names contain spaces, which the court leaves unencoded in the
      // href; the URL constructor percent-encodes them for us.
      let argURL = new URL(href, LIST_URL);
      let fileName = decodeURIComponent(last(argURL.pathname.split('/')));
      // The court emits href='...' with single quotes, so a file name
      // containing an apostrophe truncates the attribute. In those rows the
      // link text still holds the whole name, so rebuild the URL from it.
      // (The converse also happens -- truncated text, intact href -- hence
      // trusting the href whenever it already looks complete.)
      if (!fileName.endsWith('.mp3')) {
        const linkText = a.text.trim();
        if (linkText.endsWith('.mp3')) {
          fileName = linkText;
          argURL = new URL(fileName, new URL('.', argURL));
        }
      }
      // e.g. "8/10/2026 2:04:54 PM". The time is optional so a row that ever
      // drops it still yields an item, dated to midnight that day.
      const dateString = td2.text;
      const dateMatch = dateString.match(
        /(\d+)\/(\d+)\/(\d+)(?:\s+(\d+):(\d+):(\d+)\s*([AP]M))?/i
      );
      let hour = parseInt(dateMatch[4] ?? '0');
      if (dateMatch[7]) {
        // 12 AM is hour 0 and 12 PM is hour 12; every other PM hour shifts by 12.
        const pm = dateMatch[7].toUpperCase() === 'PM';
        hour = (hour % 12) + (pm ? 12 : 0);
      }
      const date = courtTimeToDate(
        parseInt(dateMatch[3]),
        parseInt(dateMatch[1]),
        parseInt(dateMatch[2]),
        hour,
        parseInt(dateMatch[5] ?? '0'),
        parseInt(dateMatch[6] ?? '0')
      );
      outItems.push({
        title: fileName,
        link: argURL.href,
        pubDate: date.toUTCString()
      });
    }
  }

  const builder = new xml2js.Builder();
  const outBody = builder.buildObject(outDoc);

  const response = {
    statusCode: 200,
    headers: {
      "Content-Type": "application/rss+xml"
    },
    body: outBody
  };

  // All log statements are written to CloudWatch
  console.info(`response from: ${event.path} statusCode: ${response.statusCode} items: ${outItems.length}`);
  return response;
}
