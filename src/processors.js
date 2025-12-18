// Processing Logic (Dependencies, Imports, HTML Parsing)

// Helper to sanitize filenames
export const cleanName = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function uint8ToString(u8) {
  if (typeof u8 === 'string') return u8;
  if (!(u8 instanceof Uint8Array)) return String(u8 ?? '');
  return new TextDecoder().decode(u8);
}

// --- Dependency Management ---

export class DependencyManager {
    constructor() {
        this.downloads = new Map(); // url -> { localPath, processPromise }
        this.vendorCount = 0;
    }

    // Resolves an import. 
    // referrerUrl is the absolute URL of the file importing this, or null if it's the root project.
    resolve(importSource, referrerUrl = null) {
        // 1. Determine URL
        let downloadUrl;
        
        if (referrerUrl) {
            // Relative to referrer (inside a vendor file)
            try {
                if (importSource.startsWith('.')) {
                    downloadUrl = new URL(importSource, referrerUrl).href;
                } else if (importSource.startsWith('http')) {
                    downloadUrl = importSource;
                } else if (importSource.startsWith('/')) {
                     const origin = new URL(referrerUrl).origin;
                     downloadUrl = new URL(importSource, origin).href;
                } else {
                    // Bare import in vendor? Assume fresh fetch from esm.sh
                    downloadUrl = `https://esm.sh/${importSource}?target=es2020&bundle`;
                }
            } catch (e) {
                console.warn("Failed to resolve URL", importSource, referrerUrl);
                return importSource;
            }
        } else {
            // Root (User Code) Import
            if (importSource.startsWith('.') || importSource.startsWith('/')) {
                return importSource; // Local project file, ignore
            }
            if (importSource.startsWith('http')) {
                downloadUrl = importSource;
            } else {
                // Bare specifier
                downloadUrl = `https://esm.sh/${importSource}?target=es2020&bundle`;
            }
        }

        // 2. Check Cache
        if (this.downloads.has(downloadUrl)) {
            return this.downloads.get(downloadUrl).localPath;
        }

        // 3. Generate Local Path (Force .js)
        let safeName = `vendor-${this.vendorCount++}`;
        try {
            const u = new URL(downloadUrl);
            const pathParts = u.pathname.split('/');
            const filename = pathParts[pathParts.length - 1];
            if (filename && filename.length < 50) {
                 const base = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9.-]/g, '_');
                 if (base) safeName = `${this.vendorCount}_${base}`;
            }
        } catch(e) {}
        
        const localPath = `./vendor/${safeName}.js`;

        // 4. Start Download & Recursion
        const processPromise = (async () => {
            try {
                const res = await fetch(downloadUrl);
                if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
                let code = await res.text();

                // Use final URL for resolving relative imports (handling redirects)
                const finalUrl = res.url;

                // Recursively rewrite imports in this vendor file
                const rewritePath = (specifier) => {
                     // Resolve the specifier relative to this download
                     const resolvedLocal = this.resolve(specifier, finalUrl);
                     
                     // resolvedLocal is ./vendor/xyz.js
                     // Since this file is also in ./vendor/, imports should be ./xyz.js
                     const parts = resolvedLocal.split('/');
                     return `./${parts[parts.length - 1]}`;
                };

                const regex = /(from\s*['"]|import\s*['"]|import\s*\(\s*['"])([^'"]+)(['"]\s*\)?)/g;
                code = code.replace(regex, (match, prefix, src, suffix) => {
                    // Skip non-imports or absolute/data URLs if resolve doesn't handle them
                    if (src.startsWith('data:')) return match;
                    return `${prefix}${rewritePath(src)}${suffix}`;
                });

                return `// Source: ${downloadUrl}\n${code}`;
            } catch (err) {
                console.error("Vendor download error:", err);
                return `/* Error downloading ${downloadUrl}: ${err.message} */`;
            }
        })();

        this.downloads.set(downloadUrl, { localPath, processPromise });
        return localPath;
    }

    async getVendorFiles() {
        const files = {};
        const processed = new Set();
        
        // Loop until no new downloads appear (handling recursion)
        while(true) {
            const urls = Array.from(this.downloads.keys());
            let hasNew = false;
            
            for(const url of urls) {
                if(processed.has(url)) continue;
                hasNew = true;
                processed.add(url);
                
                const entry = this.downloads.get(url);
                const content = await entry.processPromise;
                
                const zipPath = entry.localPath.replace(/^\.\//, '');
                files[zipPath] = content;
            }
            if(!hasNew) break;
        }
        return files;
    }
}

// Parse JS files to detect imports, download them, and rewrite paths
export function processJsForImports(jsContent, depManager) {
  let js = uint8ToString(jsContent);
  let isModule = false;

  // Basic check for module syntax
  if (/^\s*(import|export)\s/m.test(js) || /import\s*\(/.test(js)) {
    isModule = true;
  }
  
  // Regex to match imports:
  // 1. import ... from "..."
  // 2. export ... from "..."
  // 3. import("...")
  
  const replaceCallback = (match, prefix, source, suffix) => {
      // If it looks like a remote URL or bare import, resolve it
      if (source.startsWith('http') || !source.match(/^\.?\.?\//)) {
          const localPath = depManager.resolve(source);
          return `${prefix}${localPath}${suffix}`;
      }
      return match;
  };

  // Replace 'from "..."'
  js = js.replace(/(from\s*['"])([^'"]+)(['"])/g, replaceCallback);

  // Replace 'import "..."' (side effect)
  js = js.replace(/(import\s*['"])([^'"]+)(['"])/g, replaceCallback);

  // Replace dynamic import('...')
  js = js.replace(/(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g, replaceCallback);

  return { content: js, isModule };
}

// Parse HTML to extract scripts and handle import maps
export function processHtmlForCSP(htmlContent, baseFilename, depManager, knownModules = new Set()) {
  let html = uint8ToString(htmlContent);
  const extractedScripts = [];
  let scriptCounter = 0;

  // Add DOCTYPE if missing
  if (!html.trim().toLowerCase().startsWith('<!doctype')) {
    html = '<!DOCTYPE html>\n' + html;
  }

  // 1. Inject Logger & Socket Polyfill
  const polyfills = '<script src="logger.js"></script>\n    <script src="websim_socket.js"></script>';
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>\n    ' + polyfills);
  } else if (html.includes('<body>')) {
    html = html.replace('<body>', '<body>\n    ' + polyfills);
  } else {
    html = polyfills + '\n' + html;
  }

  // 2. Handle Import Maps
  // Remove import maps to prevent CSP inline script violations.
  // We rewrite all imports in JS files (including extracted inline scripts) so the map is redundant.
  html = html.replace(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi, '<!-- Import Map Removed by Converter -->');

  // 3. Process Scripts
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, content) => {
    
    // CASE A: External Script
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (srcMatch) {
        let src = srcMatch[1];
        
        // If it's remote, we must download it!
        if (src.startsWith('http') || src.startsWith('//')) {
            if (src.startsWith('//')) src = 'https:' + src;
            const localPath = depManager.resolve(src);
            // resolve returns ./vendor/..., remove ./ for src attribute if needed, 
            // but browsers handle ./ fine.
            return `<script ${attrs.replace(srcMatch[0], `src="${localPath}"`)}>${content}</script>`;
        }

        let filename = src;
        // Clean path to match map keys
        const cleanKey = filename.replace(/^(\.|\/)+/, '');
        
        if (knownModules.has(cleanKey)) {
            if (!attrs.includes('type="module"') && !attrs.includes("type='module'")) {
                return `<script type="module" ${attrs}>${content}</script>`;
            }
        }
        return match;
    }

    // CASE B: Inline Script
    if (!content.trim()) return '';

    // If it's a JSON script (importmap, ld+json), leave it alone
    if (attrs.includes('type="application/json"') || attrs.includes('type="importmap"')) {
        return match;
    }

    scriptCounter++;
    const safeBase = baseFilename.replace(/[^\w-]/g, '_');
    const scriptFilename = `${safeBase}_inline_${scriptCounter}.js`;
    
    let isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    
    const processed = processJsForImports(content, depManager);
    if (processed.isModule) isModule = true;

    extractedScripts.push({ filename: scriptFilename, content: processed.content });

    let newAttrs = attrs;
    if (isModule && !newAttrs.toLowerCase().includes('type="module"')) {
        newAttrs += ' type="module"';
    }
    
    return `<script src="${scriptFilename}" ${newAttrs}></script>`;
  });

  // Remove CSP violations
  html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');

  return { html, extractedScripts };
}

