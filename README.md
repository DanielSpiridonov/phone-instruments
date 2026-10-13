# Digital Gaida — self-hosted

This standalone version runs with Node.js 20 or newer. It has no npm dependencies or external database. Rooms are kept in memory and reset when the server restarts.

## Start

```bash
node server.js
```

The server listens on port 3000 by default. Set `PORT` to change it (for example, `PORT=8080 node server.js` on macOS/Linux, or `$env:PORT=8080; node server.js` in PowerShell).

For a PC-only check, open `http://localhost:3000`. A phone can use `http://YOUR_PC_LOCAL_IP:3000` for the manual slider, but Safari movement and tilt require a trusted HTTPS URL. Find your PC's IPv4 address with `ipconfig` on Windows. Allow Node through the firewall for private networks if needed.

Choose **Alone** to play on one phone: tap **Start audio + movement**, allow sensor access, then hold a note while moving the same phone. Choose **Multiple devices** to create a room on the button phone and join with the six-character code on the moving phone. The manual airflow slider works over local HTTP. **Motion sensors on iPhone and many Android browsers require HTTPS**; host behind an HTTPS domain or tunnel to enable movement. In multiple-device mode, both phones must open the same server address.

In alone mode, notes, motion processing, tilt and Web Audio all stay local to the phone; no room or second device is required. Holding a note selects pitch, movement controls volume, and tilt controls tone brightness.

## Hosting

Deploy this folder to a service that can run a persistent Node server and set its start command to `node server.js`. A static-only host cannot run the room API. HTTPS is recommended for motion controls. Keep the `public/audio` files alongside the site.

## Run the fixed version on two Safari phones

1. In PowerShell in this project folder, run `node server.js`. If an older copy is running, stop it with Ctrl+C first. Restarting clears existing rooms.
2. Give both phones the same **trusted HTTPS** URL. If you already host this Node server behind HTTPS, use that address. For a local PC, ngrok is an option: in a second terminal run `ngrok http 3000` and use the HTTPS forwarding URL it prints. If ngrok asks for setup, follow its [Windows setup instructions](https://ngrok.com/download/windows) and configure your own account authtoken. Keep both terminals running. A local `http://192.168...:3000` address supports the slider but cannot enable Safari movement; accepting a certificate warning is not a substitute for trusted HTTPS.
3. Open that exact HTTPS address in Safari on both phones and reload both pages. On phone 1, tap **Create a room**. On phone 2, enter its code and tap **Join**. Wait for **Both phones connected**.
4. On phone 2, tap **Start audio** and check that **Audio context** reads `running`. Set the phone's media volume to a comfortable audible level. If Safari suspends playback, tap **Resume audio**.
5. Test the slider first, then tap **Start audio + movement** on phone 2 and allow motion access. This button starts audio and requests motion together. Use the checks below. Keep both Safari pages visible and the phones unlocked during testing.

### Hold-to-play note buttons

Phone 1 has eight large named notes in a two-column grid. Hold a button to play and release to stop; buttons do not toggle. If multiple fingers hold notes, the most recently pressed note wins, then releasing it returns to any earlier note still held. Pointer cancellation, leaving the page, and loss of focus release the notes. Desktop users can also hold Space or Enter on a focused button. Movement or the manual slider still determines the volume.

Restart `node server.js` and reload both phones after an update so the room API and Safari scripts are current.

### Manual slider test (separate from sensors)

Tap **Use manual slider** on phone 2. Keep one note button held on phone 1 and move the slider through these values, allowing about half a second for gain smoothing:

| Slider | Chanter gain target | Drone gain target | Expected sound |
| --- | --- | --- | --- |
| 0% | 0.000 | 0.000 | Fades to silence |
| 50% | 0.325 | 0.150 | Audible middle volume |
| 100% | 0.650 | 0.300 | Louder, same note |

Moving the phone must not change volume in manual mode. At 50%, press and hold different note buttons on phone 1: the note on phone 2 must change while airflow stays at 50%. Release all note buttons: both chanter and drone should fade to silence. **Server airflow / finger note** should follow within a polling round trip (normally a few hundred milliseconds).

### Movement and tilt on the moving phone

Open the same trusted HTTPS address on both Safari phones. Hold a note on phone 1. On phone 2, tap **Start audio + movement** and allow motion and orientation access. Motion permission alone does not guarantee orientation data; the page reports missing or denied tilt data separately. If no usable acceleration arrives, the page shows an error instead of claiming movement is enabled.

Movement intensity is derived only from linear acceleration when all axes are valid. If values are missing, a per-axis gravity estimate is subtracted from acceleration including gravity. A small dead zone removes idle noise; the default attack is 0.09 seconds and release is 0.7 seconds. Rotation does not add airflow. At the default 100% sensitivity, ordinary movement has room to grow: about 1.6 m/s² produces roughly 46% target airflow, while about 5.1 m/s² reaches 100%. Lower **Movement sensitivity** if your playing still reaches 100% too easily. **Fade after movement** adjusts the volume response without affecting pitch or tone brightness.

Tilt uses beta and gamma from device orientation, remapped for the phone's current screen orientation. The first usable reading gives a temporary neutral position. To set the proper playing position, hold phone 2 still and tap **Calibrate tilt**; keep it still for about one second while several readings are averaged. Tilt away from that position to open the chanter low-pass filter from about 1,200 to 8,000 Hz. Returning to neutral restores the darker tone. The filter always remains above the highest played note, so tilt does not mute it. If the screen rotates, the app establishes a new temporary neutral and asks you to calibrate again. **Tilt sensitivity** changes only this tone response.

Sensor processing, airflow smoothing, tone smoothing and Web Audio parameters update on phone 2's animation loop. The room still carries the held note and connection state. A stalled room read makes a held note fade for safety; it does not make sensor processing wait for polling. The manual airflow slider still sets volume independently. Once tilt permission has been granted, switching to the slider gives a fixed volume while live tilt can still change brightness, making tone easy to audition.

Diagnostics show the raw acceleration axes, whether linear or gravity-corrected acceleration was selected, raw beta/gamma and screen angle, calculated airflow, calibrated tilt brightness, filter frequency, gains and audio state. If tilt data is unavailable, the tilt status says so while movement volume remains usable.

### Short physical Safari check

1. With a note held on phone 1, hold phone 2 still in its normal position, tap **Calibrate tilt**, and wait for **Calibrated**. Raw acceleration may show small noise, but airflow should settle near zero and filter frequency near 1,200 Hz.
2. Move phone 2 back and forth without deliberately tilting. Airflow and chanter gain should rise promptly and fall smoothly; the note name and pitch stay the same.
3. Set **Manual airflow** to about 50% on phone 2, then tilt and return to the calibrated position. Volume should stay steady while the filter frequency and audible brightness rise and return. Adjust **Tilt sensitivity** if the change is too weak or strong.
4. Switch back with **Enable movement** to test motion volume again; if the sensor session restarts, hold still and calibrate tilt again.

### Automated verification and remaining device check

Run `node --test tests/flow.test.js` (no dependencies). Tests execute the shipped app with simulated motion and Web Audio controls, exercise one-phone play and manual 0/50/100% independently, and connect two isolated clients to the real Node room server. They cover null acceleration fallback, stationary gravity, movement attack/release, orientation permission, calibration, angle wrapping, portrait/landscape mapping, neutral return, local filter updates, manual airflow, room connection, held notes and the actual recording through the intended filter range.

These tests do **not** verify a physical accelerometer, Safari's native audio engine, or speaker loudness. Complete the physical-phone checks above before treating device testing as passed. For a failure report, include the iPhone model/iOS version, HTTPS address status, motion and tilt status, raw acceleration and tilt, airflow, filter frequency, gain and audio-context state while still, moving and tilting.

## Audio source

The chanter and drone loops were extracted, filtered, and repitched from [Gaida performance in Gela, Bulgaria](https://commons.wikimedia.org/wiki/File:%D0%93%D0%B0%D0%B9%D0%B4%D0%B0%D1%80%D1%81%D0%BA%D0%BE_%D0%BD%D0%B0%D0%B4%D1%81%D0%B2%D0%B8%D1%80%D0%B2%D0%B0%D0%BD%D0%B5_-_%D1%81._%D0%93%D0%B5%D0%BB%D0%B0,_03.08.2013.webm) by dr1ve0rd1e, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). This is an ensemble field recording, not separately recorded notes. The E-based pitches and button layout are a prototype approximation, not verified traditional fingering.
