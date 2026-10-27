const test = require('node:test');
const assert = require('node:assert/strict');
const { autoSlice, manualSlice, sliceByCount } = require('../src/services/slicer');
const { plan, outputEvents, outputDuration, sourceAt } = require('../public/js/ad-schedule');
const config = { enabled: true, assetIds: ['a','b'], count: 2, duration: 6, firstStart: 26, minGap: 8, endPadding: 3, rotation: 'clip' };
test('20 minutes becomes exactly five complete clips, each with exactly two local ad events', () => {
  const segments = sliceByCount(1200, 5);
  assert.equal(segments.length, 5);
  assert.equal(segments.at(-1).end, 1200);
  const ads = plan(config, segments);
  ads.forEach((events, i) => {
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.start), [26, 231]);
    assert.equal(events[0].assetId, i % 2 ? 'b' : 'a');
    assert.equal(events[1].assetId, events[0].assetId);
  });
});
test('overlap terminates at the source end; small tails are retained', () => {
  assert.equal(autoSlice(240,120,10).at(-1).end, 240);
  assert.equal(autoSlice(241,120).at(-1).duration, 1);
  for (const overlap of [120,130,-1,NaN]) assert.throws(() => autoSlice(500,120,overlap));
});
test('per-clip count, banner, timing and disabled overrides do not affect other clips', () => {
  const events = plan({ ...config, clips: { 0: { count: 1, starts: [50], assetIds: ['b'] }, 1: { count: 0 }, 2: { enabled: false } } }, sliceByCount(1200,5));
  assert.equal(events[0][0].start, 50);
  assert.equal(events[0][0].assetId, 'b');
  assert.equal(events[0].length,1);
  assert.equal(events[1].length,0);
  assert.equal(events[2].length,0);
  assert.equal(events[3].length,2);
});
test('short clips, collisions, invalid ranges and invalid timecodes fail before rendering', () => {
  assert.throws(() => plan(config,[{duration:30}]));
  assert.throws(() => plan({...config,starts:[26,28]},[{duration:240}]));
  assert.throws(() => plan({...config,starts:[-1,20]},[{duration:240}]));
  assert.throws(() => plan({...config,opacity:2},[{duration:240}]));
  assert.throws(() => manualSlice([{start:0,end:61}],60));
  assert.throws(() => manualSlice([{start:10,end:5}],60));
  assert.throws(() => sliceByCount(1,0));
  assert.equal(sliceByCount(57.469,5).length,5);
});
test('rotation per impression and disabled ads', () => {
  const events=plan({...config,rotation:'show'},[{duration:240}])[0];
  assert.deepEqual(events.map(e=>e.assetId),['a','b']);
  assert.deepEqual(plan({enabled:false},[{duration:1}]),[[]]);
});
test('freeze insertion shifts output timing and resumes from exactly the paused source time', () => {
  const events=plan({...config,freezeOnAd:true},[{duration:240}])[0];
  assert.deepEqual(outputEvents(events).map(e=>e.start),[26,243]);
  assert.equal(outputDuration(240,events),252);
  assert.deepEqual(sourceAt(29,events),{time:26,frozen:true});
  assert.deepEqual(sourceAt(32,events),{time:26,frozen:false});
  assert.deepEqual(sourceAt(33,events),{time:27,frozen:false});
  assert.deepEqual(sourceAt(246,events),{time:237,frozen:true});
  assert.deepEqual(sourceAt(252,events),{time:240,frozen:false});
});
test('mixed native video durations and per-event static lengths produce the correct final timeline',()=>{
  const assets={a:{animated:true,duration:5},b:{animated:true,duration:2}};
  const ads=plan({...config,freezeOnAd:true,rotation:'show',duration:90},[{duration:240}],id=>assets[id])[0];
  assert.deepEqual(ads.map(e=>e.duration),[5,2]);
  assert.equal(outputDuration(240,ads),247);
  const png=plan({...config,freezeOnAd:true,staticDurations:{0:1.5,1:3}},[{duration:240}])[0];
  assert.deepEqual(png.map(e=>e.duration),[1.5,3]);
  assert.equal(outputDuration(240,png),244.5);
});
