//! The performance harness's driver of the Tauri window (docs/plans/performance.md
//! → W1, apps/web/e2e/perf/lib/tauriPage.ts). Compiled only with the
//! `perf-driver` feature, and only into a debug build; switched on per run by
//! `NARRATIVE_PERF_DRIVER_PORT`.
//!
//! What a Playwright page gives the perf specs, for the real WKWebView:
//!
//!   - **scripts in the page**: an initialization script connects every page
//!     the window loads to the driver's WebSocket on 127.0.0.1 (the port in
//!     the variable) and evaluates what the driver sends — the harness's API
//!     (`window.__narrative_perf_harness`) is read the way Playwright's
//!     `page.evaluate` reads it. A WebSocket, not fetch: Resource Timing (the
//!     harness's network counters) does not see its frames;
//!   - **native input** on stdin, one JSON command per line, answered on
//!     stdout (`{"id":…,"ok":true}`): keys, the mouse and the wheel become
//!     `NSEvent`s sent through the window (`-[NSWindow sendEvent:]`), so they
//!     reach the page as AppKit's own input does — through WebKit's UI
//!     process, trusted, with the event's time on the system clock;
//!   - the window's size, a navigation, and (a diagnostic) WebKit's device
//!     scale factor overridden, to compare with a 1× Playwright page.
//!
//! `NARRATIVE_PERF_INIT_SCRIPTS` (paths, `:`-separated) adds scripts that run
//! before the page's own, as Playwright's `addInitScript` (the React hook).

#[cfg(not(debug_assertions))]
compile_error!("the perf-driver feature is for debug builds only");

use std::io::{BufRead, Write};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url};

/// What a run asked for, from the environment.
#[derive(Clone, Debug)]
pub struct PerfConfig {
    port: u16,
    init_scripts: Vec<String>,
    /// The window's inner size at start, logical px.
    pub viewport: Option<(f64, f64)>,
}

impl PerfConfig {
    /// The driver is on when `NARRATIVE_PERF_DRIVER_PORT` names a port.
    pub fn from_env() -> Option<PerfConfig> {
        let port = std::env::var("NARRATIVE_PERF_DRIVER_PORT")
            .ok()?
            .parse::<u16>()
            .ok()?;
        let init_scripts = std::env::var("NARRATIVE_PERF_INIT_SCRIPTS")
            .ok()
            .map(|v| {
                v.split(':')
                    .filter(|p| !p.is_empty())
                    .map(|p| {
                        std::fs::read_to_string(p)
                            .unwrap_or_else(|e| panic!("NARRATIVE_PERF_INIT_SCRIPTS: {p}: {e}"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let viewport = std::env::var("NARRATIVE_PERF_VIEWPORT").ok().and_then(|v| {
            let (w, h) = v.split_once('x')?;
            Some((w.parse().ok()?, h.parse().ok()?))
        });
        Some(PerfConfig {
            port,
            init_scripts,
            viewport,
        })
    }

    /// The initialization scripts of the main window, in order: the extra ones, then the client.
    pub fn scripts(&self) -> Vec<String> {
        let mut out = self.init_scripts.clone();
        out.push(PAGE_CLIENT.replace("__PORT__", &self.port.to_string()));
        out
    }
}

/// Connects the page to the driver and evaluates what it sends: a function's
/// source and its argument (Playwright's `page.evaluate(fn, arg)`), or an
/// expression. The answer is JSON; `undefined` is sent as `{ undefined: true }`.
/// It also reports every trusted input event the page dispatches (`seen`,
/// with its time on the epoch clock): the driver's input waits for its event
/// to reach the page, as Playwright's does — WebKit queues keys and the mouse
/// apart, so without the wait a click can overtake the keys sent before it.
const PAGE_CLIENT: &str = r#"(() => {
  if (window.top !== window) return
  const url = 'ws://127.0.0.1:__PORT__/page'
  let socket = null
  const send = (msg) => {
    try { socket.send(JSON.stringify(msg)) } catch (err) { console.error('[perf-driver]', err) }
  }
  const seen = (e) => {
    if (e.isTrusted && socket !== null && socket.readyState === 1)
      send({ seen: e.type, at: performance.timeOrigin + e.timeStamp })
  }
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointermove', 'wheel'])
    window.addEventListener(type, seen, { capture: true, passive: true })
  const connect = () => {
    socket = new WebSocket(url)
    socket.onopen = () => send({ hello: location.href })
    socket.onmessage = async (m) => {
      const { id, fn, arg, isFunction } = JSON.parse(m.data)
      try {
        const f = (0, eval)(isFunction ? `(${fn})` : fn)
        const value = await (isFunction ? f(arg) : f)
        if (value === undefined) send({ id, ok: true, undefined: true })
        else send({ id, ok: true, value })
      } catch (err) {
        send({ id, ok: false, error: err && err.stack ? `${err.message}\n${err.stack}` : String(err) })
      }
    }
    socket.onclose = () => { socket = null }
  }
  connect()
})();"#;

/// One command of the driver, on stdin.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Command {
    /// A key: `down` or `up`, with its macOS key code and characters.
    Key {
        #[serde(rename = "type")]
        kind: KeyKind,
        key_code: u16,
        #[serde(default)]
        characters: String,
        #[serde(default)]
        characters_ignoring_modifiers: Option<String>,
        #[serde(default)]
        modifiers: Vec<String>,
        #[serde(default)]
        repeat: bool,
    },
    /// A modifier key pressed or released (a `flagsChanged` event).
    Flags {
        key_code: u16,
        down: bool,
        #[serde(default)]
        modifiers: Vec<String>,
    },
    /// The mouse at a point of the page (CSS px from its top left).
    Mouse {
        #[serde(rename = "type")]
        kind: MouseKind,
        x: f64,
        y: f64,
        #[serde(default = "one")]
        click_count: isize,
        #[serde(default)]
        modifiers: Vec<String>,
    },
    /// A wheel turn at a point of the page, in pixels (Playwright's `mouse.wheel`).
    Wheel {
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
        #[serde(default)]
        modifiers: Vec<String>,
    },
    /// The window's inner size, logical px; the window moves to the screen's top left.
    Resize {
        width: f64,
        height: f64,
    },
    /// Bring the window to the front and make it key.
    Focus,
    Navigate {
        url: String,
    },
    /// Override WebKit's device scale factor (0: the screen's own again). A diagnostic.
    DeviceScale {
        factor: f64,
    },
    /// The window and screen as AppKit has them.
    Info,
    /// Close the app.
    Quit,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum KeyKind {
    Down,
    Up,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum MouseKind {
    Down,
    Up,
    /// Moved with the left button held.
    Dragged,
    /// Moved with no button held.
    Moved,
}

fn one() -> isize {
    1
}

static STDOUT: Mutex<()> = Mutex::new(());

fn answer(id: &Value, result: Result<Value, String>) {
    let line = match result {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    let _guard = STDOUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Read commands from stdin until it closes (the driver went away: quit).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let parsed: Result<Value, _> = serde_json::from_str(&line);
            let Ok(raw) = parsed else {
                answer(&Value::Null, Err(format!("not JSON: {line}")));
                continue;
            };
            let id = raw.get("id").cloned().unwrap_or(Value::Null);
            let result = match serde_json::from_value::<Command>(raw) {
                Ok(Command::Quit) => {
                    answer(&id, Ok(Value::Null));
                    break;
                }
                Ok(cmd) => run(&app, cmd),
                Err(e) => Err(format!("bad command: {e}")),
            };
            answer(&id, result);
        }
        app.exit(0);
    });
}

fn run(app: &AppHandle, cmd: Command) -> Result<Value, String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    match cmd {
        Command::Resize { width, height } => {
            window
                .set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            window
                .set_position(LogicalPosition::new(0.0, 0.0))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        Command::Navigate { url } => {
            let url = Url::parse(&url).map_err(|e| e.to_string())?;
            window.navigate(url).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        Command::Focus => {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            native::focus(&window)
        }
        Command::Quit => Ok(Value::Null),
        other => native::input(&window, other),
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
    use std::sync::{mpsc, Once};
    use std::time::Duration;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel, ClassType, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSScreen, NSView, NSWindow};
    use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags, CGScrollEventUnit};
    use objc2_foundation::{NSPoint, NSProcessInfo, NSString};
    use serde_json::{json, Value};
    use tauri::WebviewWindow;

    use super::{Command, KeyKind, MouseKind};

    static EVENT_NUMBER: AtomicIsize = AtomicIsize::new(1);

    /// The mouse buttons the driver holds down (bit 0: the left one).
    static PRESSED: AtomicUsize = AtomicUsize::new(0);
    static OVERRIDE_PRESSED: Once = Once::new();

    /// `+[NSEvent pressedMouseButtons]`, as the driver holds them.
    extern "C-unwind" fn pressed_mouse_buttons(_: &AnyClass, _: Sel) -> usize {
        PRESSED.load(Ordering::Relaxed)
    }

    /// WebKit takes a mouse event's `buttons` from `+[NSEvent pressedMouseButtons]`
    /// — the hardware's state, never the event's — so a synthesised drag would
    /// reach the page with `buttons: 0` (and undoGestures.ts would end the
    /// gesture). The driver answers it instead, as WebKitTestRunner's
    /// EventSender does for WebKit's own tests.
    fn override_pressed_buttons() {
        OVERRIDE_PRESSED.call_once(|| {
            let method = NSEvent::class()
                .class_method(sel!(pressedMouseButtons))
                .expect("+[NSEvent pressedMouseButtons]");
            // SAFETY: the replacement has the method's signature (a class, a
            // selector → NSUInteger); it is installed once and never removed.
            unsafe {
                let imp: Imp = std::mem::transmute::<
                    extern "C-unwind" fn(&AnyClass, Sel) -> usize,
                    Imp,
                >(pressed_mouse_buttons);
                method.set_implementation(imp);
            }
        });
    }

    /// A Quartz event's time on the clock NSEvent uses (ns since boot, as `uptime`).
    fn stamp(cg: &CGEvent) {
        CGEvent::set_timestamp(Some(cg), (uptime() * 1e9) as u64);
    }

    /// The window and its WKWebView, on the main thread (AppKit's only thread).
    pub fn on_main<F>(window: &WebviewWindow, f: F) -> Result<Value, String>
    where
        F: FnOnce(&NSWindow, &NSView, MainThreadMarker) -> Result<Value, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |pw| {
                let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
                // SAFETY: Tauri hands over its live WKWebView and NSWindow; both
                // outlive this call, which runs on the main thread.
                let view = unsafe { &*(pw.inner() as *const NSView) };
                let win = unsafe { &*(pw.ns_window() as *const NSWindow) };
                let _ = tx.send(f(win, view, mtm));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "the main thread did not answer in 10 s".to_string())?
    }

    /// The window in front and key, the WKWebView its first responder (keys go there).
    pub fn focus(window: &WebviewWindow) -> Result<Value, String> {
        on_main(window, |win, view, _| {
            win.makeKeyAndOrderFront(None);
            win.makeFirstResponder(Some(view));
            // The person's own mouse passes through the window to what lies
            // behind it (the driver's events come through sendEvent:, which
            // this does not stop): a cursor crossing it must not add hovers
            // and moves to a measurement.
            win.setIgnoresMouseEvents(true);
            Ok(Value::Null)
        })
    }

    fn flags(modifiers: &[String]) -> NSEventModifierFlags {
        let mut f = NSEventModifierFlags::empty();
        for m in modifiers {
            f |= match m.as_str() {
                "shift" => NSEventModifierFlags::Shift,
                "control" => NSEventModifierFlags::Control,
                "alt" => NSEventModifierFlags::Option,
                "meta" => NSEventModifierFlags::Command,
                // Arrow and function keys carry these, as the keyboard's own do.
                "function" => NSEventModifierFlags::Function,
                "numericPad" => NSEventModifierFlags::NumericPad,
                _ => NSEventModifierFlags::empty(),
            };
        }
        f
    }

    fn cg_flags(modifiers: &[String]) -> CGEventFlags {
        let mut f = CGEventFlags::empty();
        for m in modifiers {
            f |= match m.as_str() {
                "shift" => CGEventFlags::MaskShift,
                "control" => CGEventFlags::MaskControl,
                "alt" => CGEventFlags::MaskAlternate,
                "meta" => CGEventFlags::MaskCommand,
                _ => CGEventFlags::empty(),
            };
        }
        f
    }

    /// Now, on the clock NSEvent timestamps use (seconds since boot).
    fn uptime() -> f64 {
        NSProcessInfo::processInfo().systemUptime()
    }

    /// A page point (CSS px from the WKWebView's top left) in window coordinates.
    fn in_window(view: &NSView, x: f64, y: f64) -> NSPoint {
        // WKWebView is flipped: its own coordinates run from the top left, as the page's do.
        let p = NSPoint::new(
            x,
            if view.isFlipped() {
                y
            } else {
                view.frame().size.height - y
            },
        );
        view.convertPoint_toView(p, None)
    }

    fn sent(win: &NSWindow, event: Option<Retained<NSEvent>>, what: &str) -> Result<Value, String> {
        let event = event.ok_or_else(|| format!("AppKit made no {what} event"))?;
        win.sendEvent(&event);
        Ok(json!({ "timestamp": event.timestamp(), "uptime": uptime() }))
    }

    pub fn input(window: &WebviewWindow, cmd: Command) -> Result<Value, String> {
        on_main(window, move |win, view, mtm| match cmd {
            Command::Key {
                kind,
                key_code,
                characters,
                characters_ignoring_modifiers,
                modifiers,
                repeat,
            } => {
                let ty = match kind {
                    KeyKind::Down => NSEventType::KeyDown,
                    KeyKind::Up => NSEventType::KeyUp,
                };
                let chars = NSString::from_str(&characters);
                let ignoring = NSString::from_str(
                    characters_ignoring_modifiers
                        .as_deref()
                        .unwrap_or(&characters),
                );
                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    ty,
                    NSPoint::new(0.0, 0.0),
                    flags(&modifiers),
                    uptime(),
                    win.windowNumber(),
                    None,
                    &chars,
                    &ignoring,
                    repeat,
                    key_code,
                );
                sent(win, event, "key")
            }
            Command::Flags {
                key_code,
                down,
                modifiers,
            } => {
                // AppKit has no constructor for flagsChanged; a Quartz keyboard event of a
                // modifier key converts into one.
                let cg = CGEvent::new_keyboard_event(None, key_code, down)
                    .ok_or("Quartz made no keyboard event")?;
                CGEvent::set_flags(Some(&cg), cg_flags(&modifiers));
                stamp(&cg);
                let event = NSEvent::eventWithCGEvent(&cg);
                sent(win, event, "flagsChanged")
            }
            Command::Mouse {
                kind,
                x,
                y,
                click_count,
                modifiers,
            } => {
                let ty = match kind {
                    MouseKind::Down => NSEventType::LeftMouseDown,
                    MouseKind::Up => NSEventType::LeftMouseUp,
                    MouseKind::Dragged => NSEventType::LeftMouseDragged,
                    MouseKind::Moved => NSEventType::MouseMoved,
                };
                override_pressed_buttons();
                match kind {
                    MouseKind::Down => PRESSED.store(1, Ordering::Relaxed),
                    MouseKind::Up => PRESSED.store(0, Ordering::Relaxed),
                    _ => {}
                }
                let pressure = if matches!(kind, MouseKind::Down | MouseKind::Dragged) {
                    1.0
                } else {
                    0.0
                };
                let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                    ty,
                    in_window(view, x, y),
                    flags(&modifiers),
                    uptime(),
                    win.windowNumber(),
                    None,
                    EVENT_NUMBER.fetch_add(1, Ordering::Relaxed),
                    if matches!(kind, MouseKind::Down | MouseKind::Up) { click_count } else { 0 },
                    pressure,
                )
                .ok_or("AppKit made no mouse event")?;
                // Straight to the WKWebView, as -[NSWindow sendEvent:] would hand
                // it over: the window ignores mouse events (focus() — the
                // person's cursor passes through it), and that also drops
                // button events sent through it. A move with no button goes to
                // the view's tracking area anyway, never through the window.
                // SAFETY: the view is the live WKWebView; each selector takes one NSEvent.
                unsafe {
                    match kind {
                        MouseKind::Down => {
                            let _: () = msg_send![view, mouseDown: &*event];
                        }
                        MouseKind::Up => {
                            let _: () = msg_send![view, mouseUp: &*event];
                        }
                        MouseKind::Dragged => {
                            let _: () = msg_send![view, mouseDragged: &*event];
                        }
                        MouseKind::Moved => {
                            let _: () = msg_send![view, mouseMoved: &*event];
                        }
                    }
                }
                Ok(json!({ "timestamp": event.timestamp(), "uptime": uptime() }))
            }
            Command::Wheel {
                x,
                y,
                dx,
                dy,
                modifiers,
            } => {
                // A wheel event comes only from Quartz: pixels, two axes. AppKit makes
                // the NSEvent with no window, so its locationInWindow is the Quartz
                // location flipped — the window point itself, not a screen point
                // (measured: a screen point landed the window's origin away).
                // sendEvent: then delivers it in this window at that point.
                let cg = CGEvent::new_scroll_wheel_event2(
                    None,
                    CGScrollEventUnit::Pixel,
                    2,
                    (-dy).round() as i32,
                    (-dx).round() as i32,
                    0,
                )
                .ok_or("Quartz made no wheel event")?;
                let at = in_window(view, x, y);
                let screens = NSScreen::screens(mtm);
                let primary_height = screens.objectAtIndex(0).frame().size.height;
                CGEvent::set_location(Some(&cg), NSPoint::new(at.x, primary_height - at.y));
                CGEvent::set_flags(Some(&cg), cg_flags(&modifiers));
                stamp(&cg);
                let n = win.windowNumber() as i64;
                CGEvent::set_integer_value_field(
                    Some(&cg),
                    CGEventField::MouseEventWindowUnderMousePointer,
                    n,
                );
                CGEvent::set_integer_value_field(
                    Some(&cg),
                    CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                    n,
                );
                let event = NSEvent::eventWithCGEvent(&cg);
                sent(win, event, "wheel")
            }
            Command::DeviceScale { factor } => {
                let s: Sel = sel!(_setOverrideDeviceScaleFactor:);
                let obj: &AnyObject = view.as_ref();
                let supported: bool = unsafe { msg_send![obj, respondsToSelector: s] };
                if !supported {
                    return Err("this WebKit has no _setOverrideDeviceScaleFactor:".into());
                }
                let _: () = unsafe { msg_send![obj, _setOverrideDeviceScaleFactor: factor] };
                Ok(Value::Null)
            }
            Command::Info => {
                let frame = view.frame();
                let wf = win.frame();
                let screens = NSScreen::screens(mtm);
                let primary = screens.objectAtIndex(0).frame();
                Ok(json!({
                    "backingScaleFactor": win.backingScaleFactor(),
                    "windowNumber": win.windowNumber(),
                    "isKeyWindow": win.isKeyWindow(),
                    "viewFlipped": view.isFlipped(),
                    "viewSize": [frame.size.width, frame.size.height],
                    "windowFrame": [wf.origin.x, wf.origin.y, wf.size.width, wf.size.height],
                    "primaryScreen": [primary.origin.x, primary.origin.y, primary.size.width, primary.size.height],
                    "screens": screens.count(),
                }))
            }
            _ => Err("not an input command".into()),
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use serde_json::Value;
    use tauri::WebviewWindow;

    use super::Command;

    const UNSUPPORTED: &str =
        "native input: macOS only so far (WebKitGTK and WebView2 take theirs differently)";

    pub fn focus(_: &WebviewWindow) -> Result<Value, String> {
        Err(UNSUPPORTED.into())
    }

    pub fn input(_: &WebviewWindow, _: Command) -> Result<Value, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Command {
        serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}"))
    }

    #[test]
    fn commands_parse_as_the_page_shim_sends_them() {
        // apps/web/e2e/perf/lib/tauriPage.ts writes these shapes.
        assert!(matches!(
            parse(
                r#"{"op":"key","type":"down","keyCode":124,"characters":"","modifiers":["function","numericPad"]}"#
            ),
            Command::Key {
                kind: KeyKind::Down,
                key_code: 124,
                ..
            }
        ));
        assert!(matches!(
            parse(r#"{"op":"flags","keyCode":55,"down":true,"modifiers":["meta"]}"#),
            Command::Flags {
                key_code: 55,
                down: true,
                ..
            }
        ));
        assert!(matches!(
            parse(r#"{"op":"mouse","type":"dragged","x":10.5,"y":20,"modifiers":[]}"#),
            Command::Mouse {
                kind: MouseKind::Dragged,
                click_count: 1,
                ..
            }
        ));
        assert!(matches!(
            parse(r#"{"op":"wheel","x":1,"y":2,"dx":0,"dy":-50,"modifiers":["meta"]}"#),
            Command::Wheel { .. }
        ));
        assert!(matches!(
            parse(r#"{"op":"deviceScale","factor":1}"#),
            Command::DeviceScale { .. }
        ));
        assert!(matches!(parse(r#"{"op":"quit"}"#), Command::Quit));
        assert!(serde_json::from_str::<Command>(r#"{"op":"eval","js":"1"}"#).is_err());
    }

    #[test]
    fn the_page_client_talks_to_the_loopback_port_only() {
        let config = PerfConfig {
            port: 41234,
            init_scripts: vec!["/* hook */".into()],
            viewport: None,
        };
        let scripts = config.scripts();
        assert_eq!(scripts.len(), 2);
        assert_eq!(scripts[0], "/* hook */");
        assert!(scripts[1].contains("ws://127.0.0.1:41234/page"));
        assert!(!scripts[1].contains("__PORT__"));
    }
}
