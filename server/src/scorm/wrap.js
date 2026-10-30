import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const RUNTIME_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'learnlens-scorm.js');
const RUNTIME_ENTRY = 'learnlens/learnlens-scorm.js';
const CONFIG_RE = /<script[^>]*data-learnlens-config[^>]*>[\s\S]*?<\/script>\s*/i;
const RUNTIME_TAG_RE = /<script[^>]*learnlens-scorm\.js[^>]*><\/script>\s*/i;

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function attr(node, name) {
  if (!node) return undefined;
  const key = Object.keys(node).find((k) => k.toLowerCase() === `@_${name.toLowerCase()}`);
  return key ? node[key] : undefined;
}

/** Reads imsmanifest.xml and returns { version, scos: [{ identifier, href }] }. */
export function readManifest(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: false });
  const doc = parser.parse(xml);
  const manifest = doc.manifest || doc['imscp:manifest'];
  if (!manifest) throw new Error('imsmanifest.xml has no <manifest> element');

  const meta = manifest.metadata || {};
  const schemaVersion = String(meta.schemaversion || '').trim();
  const isTwentyFour = /2004|CAM 1\.3/i.test(schemaVersion) || /adlcp_v1p3/.test(xml);

  const resourcesNode = manifest.resources || {};
  const base = attr(resourcesNode, 'xml:base') || '';
  const scos = [];
  for (const res of asArray(resourcesNode.resource)) {
    const type = attr(res, 'adlcp:scormtype') || attr(res, 'adlcp:scormType');
    const href = attr(res, 'href');
    if (String(type).toLowerCase() !== 'sco' || !href) continue;
    const resBase = attr(res, 'xml:base') || '';
    scos.push({ identifier: attr(res, 'identifier'), href: (base + resBase + href).split(/[?#]/)[0] });
  }
  if (!scos.length) throw new Error('No SCO resources found in imsmanifest.xml');
  return { version: isTwentyFour ? 'SCORM 2004' : 'SCORM 1.2', scos };
}

function injectIntoHtml(html, configJson, runtimeSrc) {
  const tags =
    `<script data-learnlens-config>window.LEARNLENS_CONFIG = ${configJson};</script>\n` +
    `<script src="${runtimeSrc}"></script>\n`;
  let out = html.replace(CONFIG_RE, '').replace(RUNTIME_TAG_RE, '');
  // Keep <meta charset> first, then load our script before any course script.
  const charset = /<meta[^>]*charset[^>]*>/i.exec(out);
  const head = /<head[^>]*>/i.exec(out);
  if (charset && head && charset.index > head.index && !/<script/i.test(out.slice(head.index, charset.index))) {
    const at = charset.index + charset[0].length;
    return `${out.slice(0, at)}\n${tags}${out.slice(at)}`;
  }
  if (head) return out.replace(/<head[^>]*>/i, (m) => `${m}\n${tags}`);
  if (/<html[^>]*>/i.test(out)) return out.replace(/<html[^>]*>/i, (m) => `${m}\n<head>\n${tags}</head>`);
  return tags + out;
}

function addFileToManifest(xml) {
  if (xml.includes(RUNTIME_ENTRY)) return xml;
  return xml.replace(/<resource\b[^>]*scorm[tT]ype\s*=\s*["']sco["'][^>]*?(\/?)>/g, (tag, selfClosing) => {
    const fileTag = `<file href="${RUNTIME_ENTRY}"/>`;
    if (selfClosing) return `${tag.slice(0, -2)}>${fileTag}</resource>`;
    return `${tag}${fileTag}`;
  });
}

/**
 * Wraps a SCORM zip so it also reports to LearnLens.
 * @returns {{ buffer: Buffer, version: string, launch: string, scos: string[] }}
 */
export function wrapScormPackage(zipBuffer, { endpoint, key, version, sendNames }) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error('The file is not a valid .zip');
  }
  const manifestEntry = zip.getEntry('imsmanifest.xml');
  if (!manifestEntry) {
    throw new Error('imsmanifest.xml was not found at the root of the zip. Is this a SCORM package?');
  }
  const manifestXml = manifestEntry.getData().toString('utf8');
  const manifest = readManifest(manifestXml);

  const configJson = JSON.stringify({ endpoint, key, version, sendNames: Boolean(sendNames) }).replace(/</g, '\\u003c');
  const wrapped = [];
  for (const sco of manifest.scos) {
    const entryName = decodeURIComponent(sco.href).replace(/^\.?\//, '');
    const entry = zip.getEntry(entryName);
    if (!entry || !/\.html?$/i.test(entryName)) continue;
    const depth = entryName.split('/').length - 1;
    const runtimeSrc = '../'.repeat(depth) + RUNTIME_ENTRY;
    const html = entry.getData().toString('utf8');
    zip.updateFile(entryName, Buffer.from(injectIntoHtml(html, configJson, runtimeSrc), 'utf8'));
    wrapped.push(entryName);
  }
  if (!wrapped.length) throw new Error('Could not find the HTML launch file of any SCO in the package');

  const runtime = fs.readFileSync(RUNTIME_PATH);
  if (zip.getEntry(RUNTIME_ENTRY)) zip.updateFile(RUNTIME_ENTRY, runtime);
  else zip.addFile(RUNTIME_ENTRY, runtime);
  zip.updateFile('imsmanifest.xml', Buffer.from(addFileToManifest(manifestXml), 'utf8'));

  return { buffer: zip.toBuffer(), version: manifest.version, launch: wrapped[0], scos: wrapped };
}

export { RUNTIME_PATH };
