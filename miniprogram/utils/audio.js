// utils/audio.js
const ctxMap = {};
export function playNoteAudio(noteId) {
  if (ctxMap[noteId]) {
    ctxMap[noteId].play();
    return;
  }
  const ctx = wx.createInnerAudioContext();
  ctx.src = `cloud://cloud1-1gqc5kau216c578f/note_audio/${noteId}.mp3`;
  ctx.autoplay = true;
  ctxMap[noteId] = ctx;
}
