import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewSchedule } from "../src/components/schedule/ScheduleBoard";
import { locateChromium, browserOptionProblems } from "../src/lib/publish/browser/engine";
import { waitForManualAudience } from "../src/lib/publish/browser/youtube-audience";

let browser: Browser;
test.before(async()=>{browser=await chromium.launch({executablePath:locateChromium()??undefined});});
test.after(async()=>{await browser?.close();});

test("Weekly Schedule form retains its other controls without an audience selector",()=>{
  const html=renderToStaticMarkup(React.createElement(NewSchedule,{busy:false,onCreate:()=>{throw new Error("No schedule creation in a render test");}}));
  assert.doesNotMatch(html,/YouTube audience|madeForKids|Made for Kids|Answer before activation/i);
  for(const label of ["YouTube visibility","First day (IST)","Days","Slot 1 window","Slot 2 window","Slot 3 window","Instagram after YouTube","Draw the week"])assert.ok(html.includes(label),label);
});

test("missing audience remains invalid outside the explicit manual Studio mode",()=>{
  assert.ok(browserOptionProblems("youtube",{}).some(p=>p.message.includes("made for kids")));
  assert.ok(!browserOptionProblems("youtube",{audienceMode:"studio"}).some(p=>p.message.includes("made for kids")));
  assert.ok(!browserOptionProblems("youtube",{audienceMode:"review"}).some(p=>p.message.includes("made for kids")));
});

for(const choice of ["MFK","NOT_MFK"]){
  test(`manual ${choice} is verified, with no automated audience clicks`,async()=>{
    const page=await browser.newPage();
    await page.setContent(`<button name="VIDEO_MADE_FOR_KIDS_MFK" aria-checked="false">Yes</button><button name="VIDEO_MADE_FOR_KIDS_NOT_MFK" aria-checked="true">No</button><script>document.addEventListener('click',e=>{for(const b of document.querySelectorAll('button')){b.setAttribute('aria-checked',String(b===e.target));b.replaceWith(b.cloneNode(true));}});</script>`);
    let ready!: () => void;
    const prompt = new Promise<void>(resolve => { ready = resolve; });
    const waiting=waitForManualAudience(page,line=>{if(line.startsWith("Audience: waiting"))ready();},3000);
    await prompt; // Wait until scrolling completes before replacing the radio nodes.
    await page.locator(`[name="VIDEO_MADE_FOR_KIDS_${choice}"]`).click();
    assert.equal(await waiting,choice==="MFK");
    assert.equal(await page.evaluate(()=>!!(window as typeof window & {bookreelAudienceController?:unknown}).bookreelAudienceController),false);
    await page.close();
  });
}

test("a preselected channel default and untrusted synthetic click cannot approve the audience",async()=>{
  const page=await browser.newPage();
  await page.setContent('<button name="VIDEO_MADE_FOR_KIDS_MFK" aria-checked="false">Yes</button><button name="VIDEO_MADE_FOR_KIDS_NOT_MFK" aria-checked="true">No</button>');
  const waiting=waitForManualAudience(page,()=>{},250);
  const rejected=assert.rejects(waiting,/No manual selection was verified/);
  await page.waitForFunction(()=>!!(window as typeof window & {bookreelAudienceController?:unknown}).bookreelAudienceController);
  await page.locator('button').last().evaluate(el=>(el as HTMLElement).click());
  await rejected;
  assert.equal(await page.locator('button').last().getAttribute('aria-checked'),'true');
  await page.close();
});

test("an unverifiable audience choice stops for review",async()=>{
  const page=await browser.newPage();
  await page.setContent('<button name="VIDEO_MADE_FOR_KIDS_MFK" aria-checked="false">Yes</button><button name="VIDEO_MADE_FOR_KIDS_NOT_MFK" aria-checked="false">No</button>');
  const waiting=waitForManualAudience(page,()=>{},500);
  const rejected=assert.rejects(waiting,/No manual selection was verified/);
  await page.waitForFunction(()=>!!(window as typeof window & {bookreelAudienceController?:unknown}).bookreelAudienceController);
  await page.locator('button').last().click();
  await rejected;
  await page.close();
});
