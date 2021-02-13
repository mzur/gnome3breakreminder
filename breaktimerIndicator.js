const { Clutter, GLib, Gio, St, GObject } = imports.gi;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const MessageTray = imports.ui.messageTray;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const Util = Me.imports.util;

const debug = (...messages) => {};

const REFRESH_SECONDS = 30;

class BreakTimerIndicator extends PanelMenu.Button {
  _init() {
    super._init(0.0, "Break Reminder");

    this.settings = Util.getSettings();

    this.destroyed = false;

    this.meter = new St.DrawingArea({ reactive: false, width: 18, height: 18 });
    this.meter.connect("repaint", Lang.bind(this, this.drawMeter));
    this.settings.connect(
      "changed::enabled",
      Lang.bind(this, function () {
        this.meter.queue_repaint();
      }),
    );
    this.add_child(this.meter);

    this.startTimer();

    this.buildMenu();
  }

  drawMeter() {
    let [width, height] = this.meter.get_surface_size();
    let enabled = this.settings.get_boolean("enabled");

    let cr = this.meter.get_context();
    let xc = width / 2;
    let yc = height / 2;
    let scale = Math.min(xc, yc) / 2;
    let r = scale * 1.5;

    let pct = this.elapsed / 60 / (this.settings.get_int("minutes") || 20);

    let [res, c] = Clutter.Color.from_string("#ccc");
    if (!enabled) [res, c] = Clutter.Color.from_string("#666");
    else if (pct >= 1) [res, c] = Clutter.Color.from_string("#c22");

    Clutter.cairo_set_source_color(cr, c);

    cr.translate(xc, yc);
    cr.scale(0.6, 0.6);

    cr.arc(0, -r * 1.6, r * 0.5, 0, 2 * Math.PI);
    cr.fill();

    cr.scale(1.5, 1.5);
    cr.translate(-r, -r);
    cr.moveTo(5.214844, 7.441406);
    cr.curveTo(5.214844, 7.441406, 6.328125, 8.558594, 7.441406, 7.441406);
    cr.curveTo(8.558594, 6.328125, 7.441406, 5.214844, 7.441406, 5.214844);
    cr.curveTo(7.441406, 5.214844, 1.3125, -0.917969, 0.199219, 0.199219);
    cr.curveTo(-0.917969, 1.3125, 5.214844, 7.441406, 5.214844, 7.441406);
    cr.closePath();
    cr.fill();

    let start = -1,
      end = Math.PI * 1.1;
    cr.translate(r, r);
    cr.arc(0, 0, r * 1.1, start, end);
    cr.stroke();

    if (enabled) {
      if (pct < 1) [res, c] = Clutter.Color.from_string("#666");

      pct = Math.min(end, pct * (end - start) + start);
      Clutter.cairo_set_source_color(cr, c);
      cr.arc(0, 0, r * 1.1, start, pct);
      cr.stroke();
    }
  }

  buildMenu() {
    let toggle = new PopupMenu.PopupSwitchMenuItem("", this.settings.get_boolean("enabled"));
    let message = "Remind every %s minutes";
    let minutes = this.settings.get_int("minutes") || 20;

    toggle.label.set_text(message.format(minutes));
    toggle.connect(
      "toggled",
      Lang.bind(this, function () {
        this.settings.set_boolean("enabled", toggle.state);
        if (toggle.state) this.startTimer();
      }),
    );
    this.menu.addMenuItem(toggle);

    let slider = new SliderItem(minutes / 59);
    slider.connect(
      "notify::value",
      Lang.bind(this, function (slider) {
        let val = Math.ceil(slider.value * 59) + 1;
        toggle.label.set_text(message.format(val));
        this.settings.set_int("minutes", val);
      }),
    );
    this.menu.addMenuItem(slider);

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    let w = new PopupMenu.PopupMenuItem(_("Restart Timer"));
    w.connect(
      "activate",
      Lang.bind(this, function () {
        this.startTimer();
      }),
    );
    this.menu.addMenuItem(w);
  }

  refreshTimer(timerId, initialMinutes) {
    if (this.timerId != timerId || !this.settings.get_boolean("enabled") || this.destroyed) return false;
    if (this.settings.get_int("minutes") < initialMinutes) {
      // Pref must have been changed.  Just start over.
      this.startTimer();
      return false;
    }

    try {
      let minutes = this.settings.get_int("minutes");
      let idleSeconds = 0;

      try {
        const result = GLib.spawn_command_line_sync("xprintidle")[1];
        const ms = Number(imports.byteArray.toString(result));
        idleSeconds = ms / 1000;
      } catch (e) {
        debug("Error getting idle amount.  Is xprintidle installed?");
      }

      let adj = idleSeconds / REFRESH_SECONDS > 0.8 ? -Math.max(idleSeconds, REFRESH_SECONDS) : REFRESH_SECONDS;
      this.elapsed = Math.max(0, this.elapsed + adj);

      if (this.elapsed / 60 >= minutes) {
        this.timerFinished();
      } else if (this.source) {
        this.source.destroy();
        this.source = null;
      }

      this.meter.queue_repaint();

      Mainloop.timeout_add_seconds(REFRESH_SECONDS, Lang.bind(this, this.refreshTimer, timerId, initialMinutes));
    } catch (e) {
      debug("error: " + e.toString() + "\n" + e.stack);
    }

    return false;
  }

  timerFinished() {
    this.elapsed = 0;
    let message = this.settings.get_string("message");
    if (message && !this.destroyed) {
      if (!this.source) {
        this.source = new MessageTray.Source("Break Reminder", Me.path + "/icon.svg");

        Main.messageTray.add(this.source);
        this.source.connect("destroy", () => (this.source = null));
      }

      const notification = new MessageTray.Notification(this.source, "Break Reminder", message, {
        gicon: Gio.icon_new_for_string(Me.path + "/icon.svg"),
      });

      notification.setTransient(true);
      notification.setTransient(MessageTray.Urgency.NORMAL);

      this.source.showNotification(notification);
    }
  }

  startTimer() {
    this.timerId = Math.floor(Math.random() * 10000);
    this.elapsed = 0;
    this.refreshTimer(this.timerId, this.settings.get_int("minutes") || 20);
  }

  destroy() {
    super.destroy();
    this.source && this.source.destroy();
    this.destroyed = true;
  }
}
var Indicator = GObject.registerClass(BreakTimerIndicator);

class SliderItemClass extends PopupMenu.PopupBaseMenuItem {
  _init(value) {
    super._init();
    var layout = new Clutter.GridLayout();
    this._box = new St.Widget({
      style_class: "slider-item",
      layout_manager: layout,
    });

    this._slider = new Slider.Slider(value);

    layout.attach(this._slider, 2, 0, 1, 1);
    this.add(this._box.actor, { span: -1, expand: true });
  }

  setValue(value) {
    this._slider.setValue(value);
  }

  getValue() {
    return this._slider._getCurrentValue();
  }

  setIcon(icon) {
    this._icon.icon_name = icon + "-symbolic";
  }

  connect(signal, callback) {
    this._slider.connect(signal, callback);
  }
}
var SliderItem = GObject.registerClass(SliderItemClass);
