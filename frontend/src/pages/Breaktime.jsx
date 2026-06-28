import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "../lib/api.js";
import { recordActivity } from "../lib/tracker.js";

const EMOJIS = ["🍎","🐶","🚀","🎨","🧩","☀️","🌈","🦋","🐱","🏆"];
const WORDS  = ["LEARN","STUDY","SMART","FOCUS","HAPPY","BRAVE","KIND","SHINE","BLOOM","DREAM","GROW","STAR","PEACE","LIGHT"];
const COLORS = ["#FF6B6B","#4ECDC4","#FFE66D","#A8E6CF"];
const MAX_BREAK_MINS = 5;

export default function Breaktime() {
  const [activeGame, setActiveGame]         = useState(null);
  const [quote, setQuote]                   = useState("Loading inspiration...");
  const [loadingQuote, setLoadingQuote]     = useState(false);
  const [points, setPoints]                 = useState(0);
  const [level, setLevel]                   = useState(1);
  const [score, setScore]                   = useState(0);
  const [msg, setMsg]                       = useState("");
  const [msgType, setMsgType]               = useState("info");
  const [showBreakWarning, setShowBreakWarning] = useState(false);
  const warningTimerRef = useRef(null);
  const breakStartRef   = useRef(null);

  // ── Simon ──
  const [simonSeq, setSimonSeq]     = useState([]);
  const [simonUser, setSimonUser]   = useState([]);
  const [simonStatus, setSimonStatus] = useState("idle");
  const [activeColor, setActiveColor] = useState(null);

  // ── Memory ──
  const [cards, setCards]   = useState([]);
  const [flipped, setFlipped] = useState([]);
  const [solved, setSolved]   = useState([]);

  // ── Missing Letters ──
  const [currentWord, setCurrentWord] = useState("");
  const [displayWord, setDisplayWord] = useState("");
  const [userGuess, setUserGuess]     = useState("");

  // ── Breathing ──
  const [breathPhase, setBreathPhase] = useState("Inhale");
  const [breathSize, setBreathSize]   = useState(1);

  // ── Bubble Pop ──
  const [bubbles, setBubbles] = useState([]);

  // ── Math ──
  const [equation, setEquation] = useState({ q: "", a: 0 });

  // ── Word Puzzle (crossword) ──
  const [crossword, setCrossword]         = useState({ word: "", hint: "", blanks: [] });
  const [crosswordInput, setCrosswordInput] = useState([]);
  const [crosswordDone, setCrosswordDone]   = useState(false);

  // ── Spelling Bee ──
  const SPELLING_WORDS = [
    { word: "ELEPHANT",  hint: "Large animal with a trunk" },
    { word: "RAINBOW",   hint: "Colourful arc after rain" },
    { word: "BUTTERFLY", hint: "Insect with beautiful wings" },
    { word: "MOUNTAIN",  hint: "Very tall landform" },
    { word: "SUNRISE",   hint: "When the sun comes up" },
    { word: "KNOWLEDGE", hint: "What you gain from learning" },
    { word: "FREEDOM",   hint: "Having no restrictions" },
  ];
  const [spellItem, setSpellItem]   = useState(null);
  const [spellInput, setSpellInput] = useState("");

  // ── Balloon Tap ──
  const BALLOON_AREA_H = 300; // px
  const [balloonY, setBalloonY]         = useState(120); // px from top
  const [balloonScore, setBalloonScore] = useState(0);
  const [balloonAlive, setBalloonAlive] = useState(true);
  const [balloonStarted, setBalloonStarted] = useState(false);
  const balloonIntervalRef = useRef(null);

  // ── Word Scramble ──
  const [scramble, setScramble]       = useState({ original: "", scrambled: "" });
  const [scrambleInput, setScrambleInput] = useState("");

  // ── Storytelling ──
  const [story, setStory] = useState(null);
  const [storyLoading, setStoryLoading] = useState(false);
  const [usedStoryTitles, setUsedStoryTitles] = useState([]);
  const [storyReading, setStoryReading] = useState(false);

  // ─────────────────────────────────────────────────

  const stopAllSpeech = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setStoryReading(false);
  }, []);

  const showMsg = useCallback((m, type = "info") => {
    setMsg(m); setMsgType(type);
    setTimeout(() => setMsg(""), 3200);
  }, []);

  const fetchQuote = useCallback(async () => {
    setLoadingQuote(true);
    try {
      const data = await apiFetch("/api/quote");
      setQuote(data.quote);
    } catch {
      const fallbacks = [
        "You are incredible! Every small step is a giant leap. 🌟",
        "Your unique mind is your greatest strength — keep going! 💪",
        "Progress, not perfection. You are doing amazing! ✨",
        "Your brain works in beautiful ways. Keep going! 🧠",
        "Stars shine brightest in the dark. So do you! 🌟",
      ];
      setQuote(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
    } finally { setLoadingQuote(false); }
  }, []);

  useEffect(() => { fetchQuote(); }, [fetchQuote]);

  useEffect(() => () => {
    stopAllSpeech();
  }, [stopAllSpeech]);

  useEffect(() => {
    if (activeGame !== "story") stopAllSpeech();
  }, [activeGame, stopAllSpeech]);

  // Warn after MAX_BREAK_MINS
  useEffect(() => {
    if (activeGame) {
      if (!breakStartRef.current) breakStartRef.current = Date.now();
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = setTimeout(() => {
        setShowBreakWarning(true);
        showMsg(`⏰ You've been on break for ${MAX_BREAK_MINS} minutes! Time to get back to studying.`, "warning");
      }, MAX_BREAK_MINS * 60 * 1000);
    } else {
      clearTimeout(warningTimerRef.current);
    }
    return () => clearTimeout(warningTimerRef.current);
  }, [activeGame, showMsg]);

  // Breathing animation
  useEffect(() => {
    if (activeGame !== "breathing") return;
    const phases = ["Inhale","Hold","Exhale","Rest"];
    let i = 0;
    setBreathPhase("Inhale"); setBreathSize(1.3);
    const t = setInterval(() => {
      i = (i + 1) % phases.length;
      setBreathPhase(phases[i]);
      setBreathSize(phases[i] === "Inhale" ? 1.3 : phases[i] === "Exhale" ? 0.75 : 1.05);
    }, 3500);
    return () => clearInterval(t);
  }, [activeGame]);

  // Bubble spawner
  useEffect(() => {
    if (activeGame !== "bubble") return;
    const t = setInterval(() => {
      setBubbles(prev => [...prev, {
        id: Date.now() + Math.random(),
        x: Math.random() * 80 + 5,
        y: Math.random() * 70 + 5,
        size: Math.random() * 50 + 30,
        color: ["#4f7cff","#ff6b9d","#ffd166","#06d6a0"][Math.floor(Math.random() * 4)],
      }].slice(-16));
    }, 900);
    return () => clearInterval(t);
  }, [activeGame]);

  // Balloon falling
  useEffect(() => {
    if (activeGame !== "balloon" || !balloonStarted) return;
    clearInterval(balloonIntervalRef.current);
    if (!balloonAlive) return;
    balloonIntervalRef.current = setInterval(() => {
      setBalloonY(y => {
        if (y >= BALLOON_AREA_H - 60) {
          clearInterval(balloonIntervalRef.current);
          setBalloonAlive(false);
          showMsg("🎈 Oh no! The balloon hit the ground!");
          return BALLOON_AREA_H - 60;
        }
        return y + 2.5;
      });
    }, 80);
    return () => clearInterval(balloonIntervalRef.current);
  }, [activeGame, balloonStarted, balloonAlive, showMsg]);

  const tapBalloon = () => {
    if (!balloonAlive) return;
    if (!balloonStarted) setBalloonStarted(true);
    setBalloonY(y => Math.max(10, y - 60));
    setBalloonScore(s => s + 1);
  };

  // ── Simon ──
  const playSequence = async (seq) => {
    setSimonStatus("playing");
    for (const c of seq) {
      await new Promise(r => setTimeout(r, 500));
      setActiveColor(c); await new Promise(r => setTimeout(r, 700)); setActiveColor(null);
    }
    setSimonStatus("user");
  };

  const startSimon = () => {
    const seq = [Math.floor(Math.random() * 4)];
    setSimonSeq(seq); setSimonUser([]); setLevel(1); setActiveGame("simon");
    playSequence(seq);
  };

  const handleSimon = (i) => {
    if (simonStatus !== "user") return;
    const newUser = [...simonUser, i]; setSimonUser(newUser);
    if (i !== simonSeq[newUser.length - 1]) {
      showMsg(`Game over! You reached level ${level} 🎉`);
      setPoints(p => p + level * 5); setSimonStatus("idle");
      setTimeout(() => setActiveGame(null), 2000); return;
    }
    if (newUser.length === simonSeq.length) {
      setLevel(l => l + 1);
      const next = [...simonSeq, Math.floor(Math.random() * 4)];
      setSimonSeq(next); setSimonUser([]);
      showMsg("✅ Correct! Next round…");
      setTimeout(() => playSequence(next), 1200);
    }
  };

  // ── Memory ──
  const startMemory = () => {
    const icons = EMOJIS.slice(0, 6);
    const pair = [...icons, ...icons].sort(() => Math.random() - 0.5);
    setCards(pair); setFlipped([]); setSolved([]); setScore(0); setActiveGame("memory");
  };

  const handleCard = (i) => {
    if (flipped.length === 2 || solved.includes(i) || flipped.includes(i)) return;
    const nf = [...flipped, i]; setFlipped(nf);
    if (nf.length === 2) {
      if (cards[nf[0]] === cards[nf[1]]) {
        const ns = [...solved, ...nf]; setSolved(ns); setScore(s => s + 10);
        if (ns.length === cards.length) { showMsg("🎉 All pairs matched! Amazing!"); setPoints(p => p + 30); }
        setFlipped([]);
      } else { setTimeout(() => setFlipped([]), 850); }
    }
  };

  // ── Missing Letters ──
  const startMissing = () => {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    const positions = [];
    while (positions.length < Math.max(1, Math.floor(word.length * 0.35))) {
      const p = Math.floor(Math.random() * word.length);
      if (!positions.includes(p)) positions.push(p);
    }
    const hidden = word.split("").map((c, i) => positions.includes(i) ? "_" : c);
    setCurrentWord(word); setDisplayWord(hidden.join(" ")); setUserGuess(""); setActiveGame("missing");
  };

  // ── Math ──
  const startMath = (lvl = 1) => {
    const range = lvl * 10;
    const ops = ["+", "-", "×"];
    const op = ops[Math.floor(Math.random() * (lvl > 2 ? 3 : 2))];
    let a = Math.floor(Math.random() * range) + 1, b = Math.floor(Math.random() * range) + 1, ans;
    if (op === "+") ans = a + b;
    else if (op === "-") { if (b > a) [a, b] = [b, a]; ans = a - b; }
    else ans = a * b;
    setEquation({ q: `${a} ${op} ${b} = ?`, a: ans }); setUserGuess(""); setActiveGame("math");
  };

  // ── Word Puzzle ──
  const CROSSWORD_WORDS = [
    { word: "LEARN", hint: "What you do in school" },
    { word: "BOOK",  hint: "You read this" },
    { word: "STUDY", hint: "Prepare for a test" },
    { word: "MATH",  hint: "Numbers and equations" },
    { word: "READ",  hint: "Looking at letters to understand" },
    { word: "WRITE", hint: "Making words on paper" },
    { word: "THINK", hint: "Using your brain" },
    { word: "GROW",  hint: "Getting bigger or better" },
  ];

  const startCrossword = () => {
    const item = CROSSWORD_WORDS[Math.floor(Math.random() * CROSSWORD_WORDS.length)];
    setCrossword({ word: item.word, hint: item.hint, blanks: item.word.split("").map(() => "") });
    setCrosswordInput(item.word.split("").map(() => ""));
    setCrosswordDone(false); setActiveGame("crossword");
  };

  // ── Spelling Bee ──
  const startSpelling = () => {
    const item = SPELLING_WORDS[Math.floor(Math.random() * SPELLING_WORDS.length)];
    setSpellItem(item); setSpellInput(""); setActiveGame("spelling");
    const u = new SpeechSynthesisUtterance(`Spell this word. Hint: ${item.hint}`);
    window.speechSynthesis.speak(u);
  };

  // ── Balloon ──
  const startBalloon = () => {
    setBalloonY(120); setBalloonScore(0); setBalloonAlive(true); setBalloonStarted(false);
    setScore(0); setActiveGame("balloon");
  };

  // ── Word Scramble ──
  const startScramble = () => {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    const scrambled = word.split("").sort(() => Math.random() - 0.5).join("");
    setScramble({ original: word, scrambled }); setScrambleInput(""); setActiveGame("scramble");
  };

  const startStory = async () => {
    setActiveGame("story");
    setStoryLoading(true);
    setStory(null);
    try {
      const { apiFetch } = await import("../lib/api.js");
      const data = await apiFetch(`/api/story?used=${encodeURIComponent(usedStoryTitles.join("||"))}`);
      setStory(data);
      setUsedStoryTitles(prev => [...prev, data.title]); recordActivity('story');
    } catch {
      setStory({ title: "The Brave Little Star", type: "moral", story: "Once upon a time, a tiny star was afraid it was too small to shine. But one night, when all the big stars were hidden by clouds, the little star shone with all its might. A lost traveller looked up and found their way home. The little star realised: even the smallest light can guide someone through the dark.", moral: "No matter how small you are, your light matters." });
    } finally {
      setStoryLoading(false); }
  };

  const readStoryAloud = () => {
    if (!story) return;
    stopAllSpeech();
    const text = `${story.title}. ${story.story} The moral of this story: ${story.moral}`;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.85; u.pitch = 1.1;
    u.onstart = () => setStoryReading(true);
    u.onend = () => setStoryReading(false);
    window.speechSynthesis.speak(u);
  };

  const GAMES = [
    { id: "simon",    label: "Simon Says",      icon: "🔵", desc: "Remember the colour sequence!",  action: startSimon   },
    { id: "memory",   label: "Pair Match",       icon: "🃏", desc: "Find all matching pairs!",       action: startMemory  },
    { id: "missing",  label: "Missing Letters",  icon: "🔤", desc: "Fill in the blanks!",            action: startMissing },
    { id: "breathing",label: "Breathing",        icon: "🌬️", desc: "Relax and breathe deeply",      action: () => setActiveGame("breathing") },
    { id: "bubble",   label: "Bubble Pop",       icon: "🫧", desc: "Pop all the bubbles!",           action: () => { setBubbles([]); setScore(0); setActiveGame("bubble"); } },
    { id: "math",     label: "Math Challenge",   icon: "🔢", desc: "Solve fun equations!",           action: () => startMath(1) },
    { id: "crossword",label: "Word Puzzle",      icon: "📝", desc: "Spell the mystery word!",       action: startCrossword },
    { id: "spelling", label: "Spelling Bee",     icon: "🐝", desc: "Spell from the hint!",          action: startSpelling },
    { id: "balloon",  label: "Balloon Tap",      icon: "🎈", desc: "Keep the balloon in the air!",  action: startBalloon },
    { id: "scramble", label: "Word Scramble",    icon: "🔀", desc: "Unscramble the word!",          action: startScramble },
    { id: "story",    label: "Story Time",      icon: "📚", desc: "Funny & moral AI stories!",     action: startStory   },
  ];

  const backBtn = (extraPts = 0) => (
    <button className="btn-ghost" style={{ marginTop: 12 }}
      onClick={() => { stopAllSpeech(); setActiveGame(null); if (extraPts) setPoints(p => p + extraPts); clearInterval(balloonIntervalRef.current); recordActivity('game'); }}>
      ← Back to Games
    </button>
  );

  return (
    <>
    <div className="breaktime-page">
      <div className="breaktime-header">
        <h2 className="card-title">🎮 Break Time!</h2>
        <div className="breaktime-points">⭐ {points} pts</div>
      </div>

      <div className="quote-box">
        <div className="quote-text">"{quote}"</div>
        <button className="quote-refresh" onClick={fetchQuote} disabled={loadingQuote}>
          {loadingQuote ? "⏳" : "🔄 New Quote"}
        </button>
      </div>

      {showBreakWarning && (
        <div className="break-warning">
          ⏰ You have been on break for {MAX_BREAK_MINS} minutes! It's time to go back to studying.
          <button className="btn-primary btn-sm" style={{ marginLeft: 12 }}
            onClick={() => { setActiveGame(null); setShowBreakWarning(false); breakStartRef.current = null; }}>
            📚 Back to Study
          </button>
        </div>
      )}

      {msg && <div className={`game-message ${msgType === "warning" ? "game-message-warning" : ""}`}>{msg}</div>}

      {/* ─── Game Grid ─── */}
      {!activeGame && (
        <div className="games-grid">
          {GAMES.map(g => (
            <button key={g.id} className="game-card" onClick={g.action}>
              <div className="game-card-icon">{g.icon}</div>
              <div className="game-card-title">{g.label}</div>
              <div className="game-card-desc">{g.desc}</div>
            </button>
          ))}
        </div>
      )}

      {/* ─── Simon ─── */}
      {activeGame === "simon" && (
        <div className="game-area">
          <div className="game-title">🔵 Simon Says — Level {level}</div>
          <div className="simon-status">
            {simonStatus === "playing" ? "👀 Watch carefully…" : simonStatus === "user" ? "👆 Your turn! Repeat the sequence." : ""}
          </div>
          <div className="simon-grid">
            {COLORS.map((color, i) => (
              <button key={i} className="simon-btn"
                style={{ background: color, opacity: activeColor === i ? 1 : 0.45, transform: activeColor === i ? "scale(1.15)" : "scale(1)", boxShadow: activeColor === i ? `0 0 30px ${color}` : "none", transition: "all 0.15s" }}
                onClick={() => handleSimon(i)} />
            ))}
          </div>
          {backBtn()}
        </div>
      )}

      {/* ─── Memory ─── */}
      {activeGame === "memory" && (
        <div className="game-area">
          <div className="game-title">🃏 Pair Matching — Score: {score}</div>
          <div className="memory-grid">
            {cards.map((card, i) => {
              const visible = flipped.includes(i) || solved.includes(i);
              return (
                <button key={i}
                  className={`memory-card ${visible ? "memory-card-visible" : ""} ${solved.includes(i) ? "memory-card-solved" : ""}`}
                  onClick={() => handleCard(i)}>{visible ? card : "?"}</button>
              );
            })}
          </div>
          {backBtn(score)}
        </div>
      )}

      {/* ─── Missing Letters ─── */}
      {activeGame === "missing" && (
        <div className="game-area">
          <div className="game-title">🔤 Missing Letters</div>
          <div className="word-display">{displayWord}</div>
          <input className="word-input missing-letter-input" value={userGuess} maxLength={1}
            onChange={e => setUserGuess(e.target.value.toUpperCase())} placeholder="Missing letter" />
          <div className="actions-row" style={{ justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => {
              if (userGuess && currentWord.includes(userGuess)) { showMsg("🌟 Correct!"); setPoints(p => p + 15); setTimeout(startMissing, 1200); }
              else showMsg("Try again! 🔍");
            }}>Check ✓</button>
            {backBtn()}
          </div>
        </div>
      )}

      {/* ─── Breathing ─── */}
      {activeGame === "breathing" && (
        <div className="game-area breathing-area">
          <div className="game-title">🌬️ Breathing Exercise</div>
          <div className="breathing-circle" style={{ transform: `scale(${breathSize})` }}>
            <span className="breath-phase">{breathPhase}</span>
          </div>
          <p className="breath-instruction">Follow the circle… breathe gently 🌿</p>
          {backBtn()}
        </div>
      )}

      {/* ─── Bubble Pop ─── */}
      {activeGame === "bubble" && (
        <div className="game-area">
          <div className="game-title">🫧 Bubble Pop — Score: {score}</div>
          <div className="bubble-arena">
            {bubbles.map(b => (
              <button key={b.id} className="bubble"
                style={{ left: `${b.x}%`, top: `${b.y}%`, width: b.size, height: b.size, background: b.color }}
                onClick={() => { setScore(s => s + 1); setBubbles(prev => prev.filter(p => p.id !== b.id)); }} />
            ))}
          </div>
          {backBtn(score)}
        </div>
      )}

      {/* ─── Math ─── */}
      {activeGame === "math" && (
        <div className="game-area">
          <div className="game-title">🔢 Math Challenge — Level {level}</div>
          <div className="math-equation">{equation.q}</div>
          <input type="number" className="word-input" value={userGuess}
            onChange={e => setUserGuess(e.target.value)} placeholder="Your answer" />
          <div className="actions-row" style={{ justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => {
              if (parseInt(userGuess) === equation.a) {
                showMsg("🎉 Correct! Level up!"); setPoints(p => p + 10 * level); setLevel(l => l + 1);
                setTimeout(() => startMath(level + 1), 1200);
              } else { showMsg("Not quite, try again! 🤔"); }
            }}>Check ✓</button>
            {backBtn()}
          </div>
        </div>
      )}

      {/* ─── Word Puzzle ─── */}
      {activeGame === "crossword" && (
        <div className="game-area">
          <div className="game-title">📝 Word Puzzle</div>
          <div className="crossword-hint">💡 Hint: {crossword.hint}</div>
          <div className="crossword-grid">
            {crossword.blanks.map((_, i) => (
              <input key={i} className={`crossword-cell ${crosswordDone ? "crossword-done" : ""}`}
                maxLength={1} value={crosswordInput[i] || ""}
                onChange={e => { const v = [...crosswordInput]; v[i] = e.target.value.toUpperCase(); setCrosswordInput(v); }} />
            ))}
          </div>
          <div className="actions-row" style={{ justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => {
              if (crosswordInput.join("") === crossword.word) {
                setCrosswordDone(true); showMsg("🎉 Excellent spelling!"); setPoints(p => p + 20);
                setTimeout(startCrossword, 1800);
              } else { showMsg("Keep trying! 🔍"); }
            }}>Check ✓</button>
            {backBtn()}
          </div>
        </div>
      )}

      {/* ─── Spelling Bee ─── */}
      {activeGame === "spelling" && spellItem && (
        <div className="game-area">
          <div className="game-title">🐝 Spelling Bee</div>
          <div className="spelling-hint">💡 {spellItem.hint}</div>
          <button className="btn-ghost btn-sm" style={{ marginBottom: 10 }}
            onClick={() => { const u = new SpeechSynthesisUtterance(`Hint: ${spellItem.hint}`); window.speechSynthesis.speak(u); }}>
            🔊 Hear hint again
          </button>
          <input className="word-input" style={{ textTransform: "uppercase", textAlign: "center" }}
            value={spellInput} onChange={e => setSpellInput(e.target.value.toUpperCase())} placeholder="Type the word" />
          <div className="actions-row" style={{ justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => {
              if (spellInput.trim() === spellItem.word) {
                showMsg("🐝 Correct!"); setPoints(p => p + 20); setTimeout(startSpelling, 1500);
              } else { showMsg(`The word is: ${spellItem.word}`); setTimeout(startSpelling, 2200); }
            }}>Check ✓</button>
            {backBtn()}
          </div>
        </div>
      )}

      {/* ─── Balloon Tap ─── */}
      {activeGame === "balloon" && (
        <div className="game-area">
          <div className="game-title">🎈 Balloon Tap — Score: {balloonScore}</div>

          {!balloonStarted && balloonAlive && (
            <div className="balloon-instruction-start">
              👆 Tap / click the balloon to keep it in the air!<br />
              Don't let it fall to the ground!
            </div>
          )}

          {/* Balloon play area */}
          <div className="balloon-arena-v2" onClick={tapBalloon}>
            {/* Ground */}
            <div className="balloon-ground">🌱🌱🌱🌱🌱🌱🌱🌱🌱🌱</div>
            {/* Balloon */}
            <div
              className={`balloon-object ${!balloonAlive ? "balloon-dead" : ""}`}
              style={{ top: balloonY }}
            >
              🎈
            </div>
            {/* Tap hint overlay (only before start) */}
            {!balloonStarted && balloonAlive && (
              <div className="balloon-tap-hint">TAP HERE!</div>
            )}
          </div>

          {!balloonAlive && (
            <div className="balloon-gameover">
              💥 Game Over! Score: {balloonScore}
              <button className="btn-primary btn-sm" style={{ marginLeft: 12 }} onClick={startBalloon}>Try Again</button>
            </div>
          )}

          {backBtn(balloonScore)}
        </div>
      )}

      {/* ─── Word Scramble ─── */}
      {activeGame === "scramble" && (
        <div className="game-area">
          <div className="game-title">🔀 Word Scramble</div>
          <div className="word-display" style={{ letterSpacing: "0.3em" }}>{scramble.scrambled}</div>
          <input className="word-input" style={{ textTransform: "uppercase" }} value={scrambleInput}
            onChange={e => setScrambleInput(e.target.value.toUpperCase())} placeholder="Unscramble it!" />
          <div className="actions-row" style={{ justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => {
              if (scrambleInput.trim() === scramble.original) {
                showMsg("🔀 Correct! You're amazing!"); setPoints(p => p + 20); setTimeout(startScramble, 1500);
              } else { showMsg(`The word is: ${scramble.original}`); }
            }}>Check ✓</button>
            {backBtn()}
          </div>
        </div>
      )}
    </div>

      {/* ─── Story Time ─── */}
      {activeGame === "story" && (
        <div className="game-area story-area">
          <div className="game-title">📚 Story Time</div>

          {storyLoading && (
            <div className="story-loading">
              <div className="loading-spinner"></div>
              <p>✨ AI is writing a story just for you…</p>
            </div>
          )}

          {story && !storyLoading && (
            <div className="story-card">
              <div className={`story-type-badge story-type-${story.type}`}>
                {story.type === "funny" ? "😄 Funny Story" : story.type === "moral" ? "💫 Moral Story" : "🌟 Adventure"}
              </div>
              <h3 className="story-title">{story.title}</h3>
              <div className="story-body">{story.story}</div>
              {story.moral && (
                <div className="story-moral">
                  <span className="story-moral-label">💡 Moral:</span> {story.moral}
                </div>
              )}
              <div className="story-actions">
                {storyReading
                  ? <button className="btn-ghost btn-sm" onClick={stopAllSpeech}>⏹ Stop Reading</button>
                  : <button className="btn-ghost btn-sm" onClick={readStoryAloud}>🔊 Read Aloud</button>}
                <button className="btn-primary btn-sm" onClick={startStory}>📖 Next Story</button>
              </div>
            </div>
          )}

          {backBtn()}
        </div>
      )}
    </>
  );
}
