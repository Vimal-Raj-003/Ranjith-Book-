/** Local DOM only. No platform or model requests. */
export function detailsFixture(failure = "") {
  return `<style>tp-yt-paper-item,ytcp-text-dropdown-trigger,ytcp-chip{display:block;margin:3px;padding:3px}ytcp-chip{display:inline-block}</style>
  <section id="ai-section">Altered or synthetic content
    <button role="radio" id="ai-yes" aria-checked="false" onclick="${failure === "ai" ? "" : "this.setAttribute('aria-checked','true')"}">Yes</button>
    <button role="radio" aria-checked="false">No</button>
  </section>
  <section id="language-container"><div>Video language</div><ytcp-text-dropdown-trigger onclick="document.querySelector('#languages').hidden=false">Select</ytcp-text-dropdown-trigger></section>
  <div id="languages" hidden><tp-yt-paper-item>English (India)</tp-yt-paper-item><tp-yt-paper-item onclick="document.querySelector('ytcp-text-dropdown-trigger').textContent='${failure === "language" ? "English (India)" : "English"}';this.parentElement.hidden=true">English</tp-yt-paper-item><tp-yt-paper-item>English (UK)</tp-yt-paper-item></div>
  <section>Video location<input id="location-input" aria-label="Video location" oninput="document.querySelector('#places').hidden=false"></section>
  <div id="places" hidden><tp-yt-paper-item>Chennai International Airport, Tamil Nadu</tp-yt-paper-item><tp-yt-paper-item onclick="${failure === "location" ? "" : "document.querySelector('#location-input').value='Chennai';document.body.dataset.selectedLocation=this.textContent;this.parentElement.hidden=true"}">Chennai, Tamil Nadu</tp-yt-paper-item></div>
  <section id="tags-container"><input id="text-input" aria-label="Tags"></section>
  <script>document.querySelector('#tags-container input').addEventListener('keydown',e=>{
    if(e.key!=='Enter')return;e.preventDefault();
    const chip=document.createElement('ytcp-chip'),text=document.createElement('span'),remove=document.createElement('button');
    text.id='chip-text';text.textContent=e.target.value${failure === "tags" ? ".slice(0,2)" : ""};
    remove.id='delete-icon';remove.textContent='Remove';remove.onclick=()=>setTimeout(()=>chip.remove(),${failure === "delayed-tags" ? 150 : 0});
    chip.append(text,remove);setTimeout(()=>{e.target.before(chip);e.target.value='';},${failure === "delayed-tags" ? 150 : 0});
  });</script>`;
}

// A realistic 480–500 character topic list, with quoting/separator overhead included.
export const fixtureTags = ["building daily habits", "habit formation", "small consistent actions", "daily routines", "practical self improvement", "personal growth", "behavior change", "starting small", "habit cues", "consistent practice", "making progress", "sustainable routines", "goal setting", "reducing friction", "attention management", "intentional living", "learning from setbacks", "tracking progress", "workplace productivity", "manageable goals", "daily reflection", "long term consistency", "reliable everyday habits"];
