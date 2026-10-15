"""XML fixture samples for tests."""

SYNC_STATUS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SyncStatus name="Kitchen" modelName="NODE" model="N125" brand="Bluesound" version="4.10.0" db="-42" volume="22" etag="1" syncStat="ss-1" class="streamer" mac="90:56:82:00:00:01">
  <slave id="192.168.1.21"/>
  <group>Kitchen + Patio</group>
</SyncStatus>
"""

STATUS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<status etag="2">
  <syncStat>ss-1</syncStat>
  <state>play</state>
  <volume>22</volume>
  <mute>0</mute>
  <service>Spotify</service>
  <title1>Song Title</title1>
  <artist>Artist Name</artist>
  <album>Album Name</album>
  <quality>320000</quality>
  <streamFormat>Ogg Vorbis</streamFormat>
  <image>/images/album.png</image>
  <secs>30</secs>
  <totlen>240</totlen>
  <canSeek>1</canSeek>
  <shuffle>1</shuffle>
  <repeat>2</repeat>
  <db>-42.0</db>
</status>
"""

# Synced secondary: SyncStatus has the real per-player volume; /Status mirrors group volume.
SYNC_STATUS_SLAVE = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SyncStatus name="Zone C" modelName="NODE 2i" brand="Bluesound" version="4.16.6" db="-8.7" volume="64" etag="252">
  <master port="11000">192.168.1.174</master>
</SyncStatus>
"""

# Muted player on firmware 4.16: no mute attribute, only muteVolume/muteDb (API v1.7 says mute="1").
SYNC_STATUS_MUTED = b"""<?xml version="1.0" encoding="UTF-8"?>
<SyncStatus etag="281" syncStat="281" version="4.16.22" id="192.168.1.30:11010" db="-100" volume="0" muteVolume="50" muteDb="-40.1" name="Zone One" model="CI-S2" modelName="CI S2" class="streamer" brand="NAD" mac="02:00:00:00:00:01:11010"></SyncStatus>
"""

# The documented v1.7 shape, in case a later firmware restores the attribute.
SYNC_STATUS_MUTED_DOCUMENTED = SYNC_STATUS_MUTED.replace(b'volume="0"', b'volume="0" mute="1"')

STATUS_MUTED = b"""<?xml version="1.0" encoding="UTF-8"?>
<status etag="m1">
  <db>-100</db>
  <mute>1</mute>
  <muteDb>-40.1</muteDb>
  <muteVolume>50</muteVolume>
  <state>stream</state>
  <syncStat>281</syncStat>
  <volume>0</volume>
</status>
"""

STATUS_GROUP_VOLUME = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<status etag="g1">
  <state>stream</state>
  <volume>15</volume>
  <groupVolume>15</groupVolume>
  <mute>0</mute>
  <service>AirPlay</service>
  <title1>Track</title1>
</status>
"""

STATUS_TIDAL_CONNECT = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<status etag="t1">
  <state>stream</state>
  <volume>20</volume>
  <mute>0</mute>
  <service>TidalConnect</service>
  <serviceName>TIDAL connect</serviceName>
  <title1>Song</title1>
  <artist>Artist</artist>
</status>
"""

QUEUE = b"""<?xml version="1.0" encoding="UTF-8"?>
<playlist length="1">
  <song id="1">
    <title>Track A</title>
    <art>Artist A</art>
    <alb>Album A</alb>
    <service>Spotify</service>
  </song>
</playlist>
"""

PRESETS = b"""<?xml version="1.0" encoding="UTF-8"?>
<presets>
  <preset id="1">
    <name>Morning</name>
  </preset>
</presets>
"""

CAPTURE_SETTINGS = b"""<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <menuGroup id="capture" displayName="Inputs"/>
  <menuGroup id="capture-input0" displayName="Analog Input" icon="/images/capture/ic_analoginput.png"/>
  <menuGroup id="capture-input1" displayName="Optical Input" icon="/images/capture/ic_opticalinput.png"/>
  <menuGroup id="capture-input2" displayName="HDMI ARC" icon="/images/capture/ic_tv.png"/>
  <setting id="bluetoothAutoplay" value="3"/>
</settings>
"""

# CI / custom-install players (e.g. NAD CI S2) often omit bluetoothAutoplay entirely.
CAPTURE_SETTINGS_NO_BLUETOOTH = b"""<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <menuGroup id="capture" displayName="Inputs"/>
  <menuGroup id="capture-input0" displayName="Analog Input" icon="/images/capture/ic_analoginput.png"/>
  <menuGroup id="capture-input1" displayName="Optical Input" icon="/images/capture/ic_opticalinput.png"/>
</settings>
"""

STATUS_CAPTURE_OPTICAL = b"""<?xml version="1.0" encoding="UTF-8"?>
<status>
  <state>stream</state>
  <service>Capture</service>
  <title1>Optical Input</title1>
  <inputId>input1</inputId>
  <inputTypeIndex>spdif-1</inputTypeIndex>
  <streamUrl>Capture:spdif-input?id=input1</streamUrl>
  <volume>8</volume>
  <mute>0</mute>
</status>
"""

AUDIO_SETTINGS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<settings pageId="audio" schemaVersion="28">
  <menuGroup id="audio" displayName="Audio" url="/audiomodes">
    <setting id="eq-switch" name="eq-switch" displayName="Tone Controls" url="/alsa_setting" class="boolean" value="ON"></setting>
    <setting id="eq-treble" name="eq-treble" displayName="Treble" url="/alsa_setting" class="range" value="4">
      <value min="-6" max="6" step="0.5" units="dB"></value>
      <dependsOn name="eq-switch" value="ON"></dependsOn>
    </setting>
    <setting id="replayGainMode" name="replayGainMode" displayName="Replay-gain" url="/audiomodes" class="list" value="none">
      <value displayName="Disabled" name="none"></value>
      <value displayName="Track gain" name="track"></value>
    </setting>
    <setting id="volumeLimits" name="volumeLimits" displayName="Volume limits (dB)" class="dual-range" value="-90,-20">
      <value min="-90" max="0" minRange="30" units="dB"></value>
    </setting>
    <setting id="reset" name="reset" displayName="Reset All" url="/alsa_setting" class="button"></setting>
  </menuGroup>
</settings>
"""

PLAYER_SETTINGS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<settings pageId="player" schemaVersion="28">
  <menuGroup id="player" displayName="Player">
    <setting id="wifi" name="wifi" displayName="WiFi">
      <webview url="http://192.168.1.20:80/wificfg?noheader=1"></webview>
    </setting>
    <setting id="nodename" name="nodename" displayName="Room name" url="/Name" class="text" value="Kitchen" disable="true" explanation="Locked by Apple Home"></setting>
    <setting id="ledbrightness" name="ledbrightness" displayName="Indicator brightness" url="/setting" class="list" value="default">
      <value displayName="Normal" name="default"></value>
      <value displayName="Dim" name="dim"></value>
      <value displayName="Off" name="off"></value>
    </setting>
    <setting id="amplifierStandby" name="amplifierStandby" displayName="Amplifier Standby" url="/setting" class="boolean" value="ON"></setting>
  </menuGroup>
</settings>
"""
