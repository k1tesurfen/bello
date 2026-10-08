/** Inline stylesheet of report.html. `--primary` is injected from the company branding. */
export function reportCss(primary: string): string {
  return `
:root{--primary:${primary};--ink:#1f2328;--muted:#59636e;--line:#d0d7de;--bg:#fff;--soft:#f6f8fa;
--rot:#cf222e;--gelb:#bf8700;--gruen:#1a7f37;--kritisch:#82071e;--hoch:#cf222e;--mittel:#bf8700;--info:#0969da}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:1000px;margin:0 auto;padding:0 24px 48px}
h1{font-size:30px;margin:0 0 8px}
h2{font-size:20px;margin:36px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--primary)}
h3{font-size:16px;margin:22px 0 8px}
h4{font-size:14px;margin:14px 0 6px}
p{margin:6px 0}
a{color:var(--info)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12.5px}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top;word-break:break-word}
th{background:var(--soft)}
.muted{color:var(--muted)}
.cover{min-height:240px;padding:40px 0 24px;border-bottom:6px solid var(--primary);margin-bottom:8px}
.cover .brand{display:flex;align-items:center;gap:16px;margin-bottom:48px}
.cover .brand img{max-height:64px;max-width:240px}
.cover .brand .name{font-size:20px;font-weight:600;color:var(--primary)}
.cover .sub{font-size:16px;color:var(--muted);margin-bottom:24px}
.cover dl{display:grid;grid-template-columns:140px 1fr;gap:4px 12px;margin:0}
.cover dt{color:var(--muted)}.cover dd{margin:0;font-weight:600;word-break:break-all}
.ampel{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:6px;background:var(--soft)}
.dot{width:34px;height:34px;border-radius:50%;flex:none}
.dot.rot{background:var(--rot)}.dot.gelb{background:var(--gelb)}.dot.gruen{background:var(--gruen)}
.ampel .label{font-size:18px;font-weight:700}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:11.5px;font-weight:600;letter-spacing:.3px}
.sev-KRITISCH{background:var(--kritisch)}.sev-HOCH{background:var(--hoch)}.sev-MITTEL{background:var(--mittel)}.sev-INFO{background:var(--info)}
.counts{display:flex;gap:10px;margin:12px 0;flex-wrap:wrap}
.counts div{border:1px solid var(--line);border-radius:6px;padding:6px 14px;text-align:center;min-width:90px}
.counts b{display:block;font-size:22px}
.finding{border:1px solid var(--line);border-left:5px solid var(--line);border-radius:4px;padding:10px 14px;margin:10px 0;break-inside:avoid}
.finding.KRITISCH{border-left-color:var(--kritisch)}.finding.HOCH{border-left-color:var(--hoch)}
.finding.MITTEL{border-left-color:var(--mittel)}.finding.INFO{border-left-color:var(--info)}
.finding h4{margin-top:0}
.meta{display:grid;grid-template-columns:150px 1fr;gap:2px 10px;font-size:12.5px;margin:6px 0}
.meta dt{color:var(--muted)}.meta dd{margin:0}
.fix{background:#ddf4e4;border-left:3px solid var(--gruen);padding:6px 10px;margin:8px 0;border-radius:3px}
.warn{background:#fff8c5;border-left:3px solid var(--gelb);padding:6px 10px;margin:8px 0;border-radius:3px}
.yes{color:var(--rot);font-weight:700}.no{color:var(--gruen)}
.tl{margin:8px 0 16px;break-inside:avoid}
.tl svg{width:100%;height:auto;display:block;border:1px solid var(--line);border-radius:4px;background:#fff}
.legend{font-size:12px;color:var(--muted)}
.legend span{display:inline-block;margin-right:14px}
.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:middle}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.shots figure{margin:0;break-inside:avoid}
.shots img{width:100%;border:1px solid var(--line)}
.shots figcaption{font-size:11.5px;color:var(--muted)}
footer.end{margin-top:40px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px}
@media print{
  @page{size:A4;margin:0}
  body{font-size:11.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  main{max-width:none;padding:0 15mm}
  .cover{page-break-after:always;break-after:page;min-height:240mm}
  h2{page-break-before:always;break-before:page;margin-top:0}
  h2.nobreak{page-break-before:avoid;break-before:avoid}
  h2,h3,h4{break-after:avoid}
  tr,figure,.finding,.tl{break-inside:avoid}
  a{color:inherit;text-decoration:none}
  .shots{grid-template-columns:repeat(2,1fr)}
}
`;
}
