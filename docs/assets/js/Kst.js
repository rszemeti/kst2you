var settings = [];
var debug;
var ws;
var connectState;
var connCount = 0;

const websocketServerUrls = 
      [
          "wss://bff.live-bidder.com/kst/",
          "wss://live2.live-bidder.com/kst/"
      ];

var lastMsg;
var latestMessageTime = 0;
var lastError;
var rawMsg;

var reader;
var newLocation; // grid square stored for set lat/long
var myLoc;
var preciseMyLoc;
var kstServerLoc;
var myLatLong;
var sessionKey;
var map;
var stationList = {};
var messageLog = {}
var chatPopupCallsign;
var ngList;

var clusterList=[];
var activeCluster;

var chatId;
var userName;
var password;
var remoteSettingsNamespace = null;

var userList = [];
var dataTableUsers;
var locAutoReplyKeys = new Set();

function getClientSoftwareVersion() {
  const releaseTagMeta = document.querySelector('meta[name="kst-release-tag"]');
  const releaseTag = releaseTagMeta?.content?.trim();

  if (releaseTag && releaseTag !== '__KST_RELEASE_TAG__') {
    return 'KST2You ' + releaseTag;
  }

  return 'KST2You dev';
}

const clientSoftwareVersion = getClientSoftwareVersion();
const preciseLocatorStorageKey = 'kst2you_precise_locator';
const preciseLocatorPattern = /^[A-R]{2}\d{2}[A-X]{2}\d{2}$/i;
const locAutoReplyStorageKey = 'kst2you_loc_autoreply';
const remoteSettingsSyncStorageKey = 'kst2you_remote_settings_sync';

function renderReleaseTag() {
  $('#releaseTagLabel').text(clientSoftwareVersion.replace(/^KST2You\s+/, ''));
}

function normalizePreciseLocator(locator) {
  const normalized = (locator || '').trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  return preciseLocatorPattern.test(normalized) ? normalized : '';
}

function getStoredPreciseLocator() {
  const stored = normalizePreciseLocator(localStorage.getItem(preciseLocatorStorageKey));
  return stored || null;
}

function locatorPrefixesMatch(preciseLocator, kstLocator) {
  if (!preciseLocator || !kstLocator) {
    return false;
  }

  return preciseLocator.substring(0, 6).toUpperCase() === kstLocator.substring(0, 6).toUpperCase();
}

function renderLocationSettings() {
  const storedPreciseLocator = preciseMyLoc || getStoredPreciseLocator() || '';
  const remoteSyncEnabled = isRemoteSettingsSyncEnabled();
  $('#settings-kst-locator').text(kstServerLoc || (myLoc ? myLoc.substring(0, 6) : '—'));
  $('#settings-precise-locator').val(storedPreciseLocator);
  $('#settings-autoresponder-loc').prop('checked', isLocAutoReplyEnabled());
  $('#settings-sync-remote-storage').prop('checked', remoteSyncEnabled);
  $('#settings-remote-data-actions').toggleClass('d-none', !remoteSyncEnabled);
}

function isRemoteSettingsSyncEnabled() {
  return localStorage.getItem(remoteSettingsSyncStorageKey) === 'true';
}

function buildRemoteUserSettingsPayload() {
  return {
    rotatorType: localStorage.getItem('kst2you_rotator_type') || 'auto',
    rotatorPort: localStorage.getItem('kst2you_rotator_port') || '',
    preciseLocator: getStoredPreciseLocator() || '',
    locAutoReply: isLocAutoReplyEnabled()
  };
}

function syncRemoteUserSettings() {
  if (!isRemoteSettingsSyncEnabled() || typeof ContestLog === 'undefined' || !ContestLog.saveUserSetting) {
    return;
  }

  ContestLog.saveUserSetting(buildRemoteUserSettingsPayload());
}

function deriveRemoteSettingsNamespace(callsign, passwordText) {
  const normalizedCallsign = ((callsign || '').trim().toUpperCase()).replace(/[\/\-].*$/, '');
  if (!normalizedCallsign || !passwordText) {
    return Promise.resolve(null);
  }

  const seed = normalizedCallsign + ':' + passwordText;
  if (!window.crypto || !window.crypto.subtle || typeof TextEncoder === 'undefined') {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return Promise.resolve('fnv1a_' + (hash >>> 0).toString(16).padStart(8, '0').toUpperCase());
  }

  return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)).then(function(buffer) {
    return Array.from(new Uint8Array(buffer)).map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  });
}

function refreshRemoteSyncNamespace() {
  if (!isRemoteSettingsSyncEnabled() || !userName || !password) {
    remoteSettingsNamespace = null;
    if (typeof ContestLog !== 'undefined' && ContestLog.setRemoteNamespace) {
      ContestLog.setRemoteNamespace(null);
    }
    return Promise.resolve(null);
  }

  return deriveRemoteSettingsNamespace(userName, password).then(function(namespace) {
    remoteSettingsNamespace = namespace;
    if (typeof ContestLog !== 'undefined' && ContestLog.setRemoteNamespace) {
      ContestLog.setRemoteNamespace(namespace);
    }
    return namespace;
  });
}

function setRemoteSettingsSyncEnabled(enabled) {
  localStorage.setItem(remoteSettingsSyncStorageKey, enabled ? 'true' : 'false');
  renderLocationSettings();

  refreshRemoteSyncNamespace().then(function(namespace) {
    if (enabled && namespace) {
      syncRemoteUserSettings();
    }
  });
}

function getLocatorForChatShare() {
  if (chatId == '3' && preciseMyLoc) {
    return preciseMyLoc;
  }

  if (myLoc) {
    return myLoc.substring(0, 6);
  }

  return '';
}

function isLocAutoReplyEnabled() {
  const stored = localStorage.getItem(locAutoReplyStorageKey);
  if (stored === null) {
    return true;
  }

  return stored === 'true';
}

function setLocAutoReplyEnabled(enabled, saveToCloud) {
  localStorage.setItem(locAutoReplyStorageKey, enabled ? 'true' : 'false');
  renderLocationSettings();

  if (saveToCloud && isRemoteSettingsSyncEnabled() && typeof ContestLog !== 'undefined' && ContestLog.saveUserSetting) {
    ContestLog.saveUserSetting({ locAutoReply: !!enabled });
  }
}

function getChatPeerLocator(callsign) {
  const station = stationList[callsign];
  if (station && station.locator) {
    return station.locator;
  }

  if (typeof ChatInbox !== 'undefined' && ChatInbox.getMeta) {
    const meta = ChatInbox.getMeta(callsign);
    if (meta && meta.locator) {
      return meta.locator;
    }
  }

  return '';
}

function reciprocalBearing(degrees) {
  return (degrees + 180) % 360;
}

function bearingToCompass(degrees) {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round((((degrees % 360) + 360) % 360) / 45) % points.length];
}

function buildLocatorReply(callsign) {
  const locator = getLocatorForChatShare();
  if (!callsign || !locator) {
    return '';
  }

  const peerLocator = getChatPeerLocator(callsign);
  if (!peerLocator || !myLatLong || typeof gridSquareToLatLon !== 'function') {
    return 'loc: ' + locator;
  }

  try {
    const peerLatLong = gridSquareToLatLon(peerLocator);
    const headingToPeer = bearing(myLatLong[0], myLatLong[1], peerLatLong[0], peerLatLong[1]);
    const beamForMe = reciprocalBearing(headingToPeer);
    const distanceKm = distVincenty(myLatLong[0], myLatLong[1], peerLatLong[0], peerLatLong[1]) / 1000;

    return 'loc: ' + locator +
      '  beam: ' + beamForMe.toFixed(1) + ' degrees (' + bearingToCompass(beamForMe) + ') for me, ' +
      Math.round(distanceKm) + ' km';
  } catch (error) {
    return 'loc: ' + locator;
  }
}

function sendLocatorToCallsign(callsign) {
  const locatorReply = buildLocatorReply(callsign);
  if (!callsign || !locatorReply) {
    return false;
  }

  sendMsg('MSG|' + chatId + '|0|/CQ ' + callsign + ' ' + locatorReply + '|0|');
  return true;
}

function isLocatorRequest(text) {
  return /^\s*\??\s*(loc|locator)\s*\??\s*$/i.test(text || '');
}

function maybeAutoReplyWithLocator(message, isLive) {
  if (!isLive || !message.isDirectTo(userName) || message.from === userName) {
    return;
  }

  if (!isLocAutoReplyEnabled() || !isLocatorRequest(message.text)) {
    return;
  }

  const replyKey = [message.from, message.timestamp, (message.text || '').trim().toLowerCase()].join('|');
  if (locAutoReplyKeys.has(replyKey)) {
    return;
  }

  if (sendLocatorToCallsign(message.from)) {
    locAutoReplyKeys.add(replyKey);
  }
}

function setStoredPreciseLocator(locator, saveToCloud) {
  const normalized = normalizePreciseLocator(locator);

  if (normalized) {
    localStorage.setItem(preciseLocatorStorageKey, normalized);
  } else {
    localStorage.removeItem(preciseLocatorStorageKey);
  }

  preciseMyLoc = normalized || null;
  renderLocationSettings();

  if (saveToCloud && isRemoteSettingsSyncEnabled() && typeof ContestLog !== 'undefined' && ContestLog.saveUserSetting) {
    ContestLog.saveUserSetting({ preciseLocator: normalized });
  }
}

function clearStoredPreciseLocator(saveToCloud) {
  setStoredPreciseLocator('', saveToCloud);
}

function applyStoredPreciseLocator() {
  const storedPreciseLocator = getStoredPreciseLocator();

  if (!storedPreciseLocator) {
    preciseMyLoc = null;
    renderLocationSettings();
    return false;
  }

  preciseMyLoc = storedPreciseLocator;

  if (kstServerLoc && !locatorPrefixesMatch(storedPreciseLocator, kstServerLoc)) {
    clearStoredPreciseLocator(true);
    if (kstServerLoc) {
      setMyLocator(kstServerLoc);
    }
    return false;
  }

  setMyLocator(storedPreciseLocator);
  return true;
}

window._applyStoredPreciseLocator = applyStoredPreciseLocator;


const locTest = RegExp('\w{6}');

var currentInfoWindow = null;

const chatGroups = [
    {id: '10', name: 'kHz (2000 m - 630 m)', min: 0, max: "1", defaultDistance: 20000},
    {id: "4", name: 'low band (160 m - 40 m)', min: 1, max: "8", defaultDistance: 20000},
    {id: '12', name: '28 MHz chat', min: 27, max: 29, defaultDistance: 20000},
    {id: '11', name: 'WARC (30 m, 17 m, 12 m)', min: 5, max: 30, defaultDistance: 20000},
    {id: "13", name: '40MHz (8m)', min: 40, max: 41, defaultDistance: 2000},
    {id: "1", name: '50-70MHz', min: 50, max: 70, defaultDistance: 2000},
    {id: "7", name: '50 MHz IARU R2', min: 50, max: 52, defaultDistance: 2000},
    {id: "6", name: '50 MHz IARU R3', min: 50, max: 54, defaultDistance: 2000},
    {id: "2", name: '144-432 MHz', min: 144, max: 432, defaultDistance: 2000},
    {id: "8", name: '144 & 432 MHz IARU R2', min: 144, max: 438, defaultDistance: 1000},
    {id: "9", name: '144 & 432 MHz IARU R3', min: 144, max: 438, defaultDistance: 1000},
    {id: "3", name: 'Microwave', min: 1296, max: 300000, defaultDistance: 1000},
    {id: "5", name: 'EME/JT65', min: 1, max: 7, defaultDistance: 25000},
];

function getBandDataById(chatId) {
    chatIdString = chatId.toString();
    return chatGroups.find(band => band.id == chatIdString);
}

class Station {

  constructor(msg, myLatLong) {
    var userData = msg.split("|");
    if (userData.length != 7) {
      this._ok = false;
      return;
    }
    this._callsign = userData[2];
    this._name = userData[3];
    this._locator = userData[4];
    this._state = userData[5];
    this._ok = true;
    this._isAway = ((0x01 & this._state) == 0x01);

    try {
      this.latLong = gridSquareToLatLon(this.locator);
      this._distance = distVincenty(myLatLong[0], myLatLong[1], this.latLong[0], this.latLong[1]) / 1000;
      this._bearing = bearing(myLatLong[0], myLatLong[1], this.latLong[0], this.latLong[1]);
    } catch (e) {
      this._ok = false;
      console.log("Distance error: " + this.locator + ' for ' + this.callsign);
      this.latLong = [0, 0];
      this._distance = '???';
    }
  }

  get decoratedCallsign() {
    if (this.isAway()) {
      return "(" + this._callsign + ")";
    } else {
      return this._callsign;
    }
  }

  get distance() {
    return this._distance;
  }
  get bearing() {
    return this._bearing;
  }

  isAway() {
    return this._isAway;
  }

  setAway() {
    this._isAway = true;
    if (typeof this.marker != 'undefined') {
      this.marker.setIcon('https://maps.google.com/mapfiles/ms/icons/red-dot.png');
      this.marker.setTitle(this.decoratedCallsign);
    }
  }

  setBack() {
    this._isAway = false;
    if (typeof this.marker != 'undefined') {
      this.marker.setIcon('https://maps.google.com/mapfiles/ms/icons/green-dot.png');
      this.marker.setTitle(this.decoratedCallsign);
    }
  }

  get callsign() {
    return this._callsign;
  }

  get decoratedCallsign() {
    if (this.isAway()) {
      return "(" + this._callsign + ")";
    } else {
      return this._callsign;
    }
  }
  get locator() {
    return this._locator;
  }
  get name() {
    return this._name;
  }
  get lat() {
    return this.latLong[0];
  }
  get long() {
    return this.latLong[1];
  }
    
  set marker(m) {
    this._marker = m;
  }
  get marker() {
    return this._marker;
  }
  get isOK() {
    return this._ok;
  }
  get distb() {
    return parseInt(this._distance).toLocaleString() + 'km / ' + parseInt(this._bearing) + '°';
  }

}

// CH|3|1696934988|SERVER|message|G1YFG|Your name is now "Robin 3cm".|0|
class Message {
  constructor(msgString) {
    var msg = msgString.split("|");
    this._timestamp = msg[2];
    this._from = msg[3];
    this._status = msg[5];
    this._text = msg[6];
    this._rawTo = msg[7];
    this._to = this._rawTo;
    if(this._to==0){
        var poss = this._text.split(' ')[0].toUpperCase();
        poss=poss.replace(/^[\[\(]|[\]\)]$/g, '');
        if(poss.includes(userName)){
            this._to=userName;
        }else if(typeof stationList[poss] != 'undefined'){
            this._to=poss;
        }
    }
  }

  get status() {
    return this._status.toUpperCase();
  }

  get from() {
    return this._from.toUpperCase();
  }

  get to() {
    return this._to.toUpperCase();
  }

  get rawTo() {
    return (this._rawTo || '').toUpperCase();
  }

  isDirectTo(callsign) {
    return this.rawTo !== '0' && this.rawTo === (callsign || '').toUpperCase();
  }

  get timestamp() {
    return parseInt(this._timestamp);
  }

  get text() {
    return this._text;
  }

  get date() {
    if (typeof this._date == 'undefined') {
      var date = new Date(this._timestamp * 1000);
      var hours = date.getHours().toString().padStart(2, '0');
      var minutes = date.getMinutes().toString().padStart(2, '0');
      var seconds = date.getSeconds().toString().padStart(2, '0');
      this._date = hours + ':' + minutes + ':' + seconds;
    }
    return this._date;
  }
}


let urlId = 0;
let retryCount = 0;
const maxRetriesPerServer = 5;   // number of retries per server
const websocketRetryDelay = 1000; // delay between retries in ms


function websocketInit(urls) {
    function connect() {
        if (ws !== null) {
            try {
                ws.onclose = null;
                ws.onerror = null;
                ws.close();
            } catch (e) {
                console.warn('Error closing old WebSocket:', e);
            }
        }

        const url = urls[urlId];
        console.log('Connecting to: ' + url);

        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

        ws.onmessage = function (msg) {
            if (msg.data instanceof ArrayBuffer) {
                const text = new TextDecoder("utf-8").decode(msg.data);
                procMsgs(text);
            } else {
                alert(msg.data);
            }
        };

        ws.onopen = function () {
            console.log('WebSocket connected.');
            $('#connState').text("connected");
          sendMsg("LOGINC|" + userName + "|" + password + "|" + chatId + "|" + clientSoftwareVersion + "|20|20|1|" + latestMessageTime + "|" + latestMessageTime + "|");
            connectState = 'connected';

            // 🟢 Successful connect -> reset retry count
            retryCount = 0;
        };

        ws.onclose = function () {
            if (connectState === 'logOff') {
                $('#connState').text('connection closed');
                $("#loginModal").modal();
            } else {
                console.warn('WebSocket closed. Attempting reconnect...');
                attemptNextServer();
            }
        };

        ws.onerror = function (evt) {
            lastError = evt;
            procWsError(evt);
            console.error('WebSocket error:', evt);
            attemptNextServer();
        };
    }

    function attemptNextServer() {
        if (retryCount < maxRetriesPerServer) {
            retryCount++;
            console.warn(`Retry ${retryCount}/${maxRetriesPerServer} on ${websocketServerUrls[urlId]}`);
            setTimeout(connect, websocketRetryDelay); // Retry after a delay
        } else {
            retryCount = 0;
            urlId++;
            if (urlId < urls.length) {
                console.warn(`Switching to next URL: ${urls[urlId]}`);
                setTimeout(connect, 500); // short delay to try next server
            } else {
                console.error("Unable to connect to any servers.");

                if (ws) {
                    try {
                        ws.onclose = null;
                        ws.onerror = null;
                        ws.close();
                    } catch (e) {
                        console.warn('Error cleaning up WebSocket:', e);
                    }
                    ws = null;
                }

                connectState = 'logOff';
                urlId = 0;

                $('#loginError').show();
                $("#loginModal").modal('show');
                $('#loginErrorMessage').text("Unable to connect to any proxy server. Try refreshing your browser and if no luck, please try again later and let G1YFG know.");
                alert("Unable to connect to any proxy server. Try refreshing your browser and if no luck, please try again later and let G1YFG know.");
            }
        }
    }

    connect();
}

function reconnect() {
    if (connectState !== 'reconnecting') {
        connectState = 'reconnecting';
        $('#connState').text('re-connecting');
        setTimeout(function () {
            connCount++;
            console.warn('Attempting to reconnect at ' + new Date());

            urlId = 0;  // Always restart at server 0
            retryCount = 0; // Also reset retry count

            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                console.log('Closing existing WebSocket before reconnecting.');
                try {
                    ws.close();
                } catch (e) {
                    console.warn('Error force closing WebSocket:', e);
                }
                ws = null;
            }

            websocketInit(websocketServerUrls);
        }, 5000); // Retry after 5 seconds
    }
}

function doLogin() {
    chatId = $('#chatId').val();
    userName = $('#userInput').val().toUpperCase();
    password = $('#passInput').val();
    if (typeof ChatInbox   !== 'undefined') ChatInbox.init(userName);

    if ($('#rememberMe').is(':checked')) {
        var cookieData = {
            user: userName,
            pass: password,
            chatId: chatId,
        };
        setCookie("kst2youUserDetails", JSON.stringify(cookieData), 90);
    } else {
        eraseCookie("kst2youUserDetails");
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('Closing existing WebSocket before login.');
        try {
            ws.close();
        } catch (e) {
            console.warn('Error closing WebSocket on login attempt:', e);
        }
        ws = null;
    }

    connectState = 'login';
    connCount = 0;
    urlId = 0;       // Reset to start at server 0
    retryCount = 0;  // Reset retry count
    websocketInit(websocketServerUrls);
}
function procWsError(evt) {
    console.warn("Error connecting to " + evt.target.url);
}


let incompleteMessage = '';

function procMsgs(msgs) {
  let combinedMsgs = incompleteMessage + msgs;
  incompleteMessage = '';
  let list = combinedMsgs.split(/\r\n/);

  if (list.length > 0 && !list[list.length - 1].endsWith('\r\n')) {
    incompleteMessage = list.pop();
  }

  if (Array.isArray(list)) {
    list.forEach(function(value, index, array) {
      procMsg(value);
    });
  }
}

function procMsg(msg) {
  console.log("< " + msg);
  $('#debugWindow').append("< " + msg + "\n<br/>")
  if (msg.startsWith("Java login")) {

  } else if (msg.startsWith("LOGSTAT|100")) {
    procLogin(msg);
  } else if (msg.startsWith("LOGSTAT|1")) {
    procLoginError(msg);
  } else if (msg.startsWith("UA0")) {
    procUser(msg);
  } else if (msg.startsWith("US6")) {
    procUserStatus(msg);
  } else if (msg.startsWith("UE")) {
    filterChatByDistance();
  } else if (msg.startsWith("UA5")) {
    procUser(msg);
  } else if (msg.startsWith("UR6")) {
    removeUser(msg);
  } else if (msg.startsWith("CR")) {
    procChatMessage(msg, false);
  } else if (msg.startsWith("CH")) {
    procChatMessage(msg, true);
  }
}

function decorate(callsign){
    if(callsign === '0'){
        return "<span style='border: ;background: red;padding: 5px;color: aliceblue;'>CQ</span>";
    }
    var stn = stationList[callsign];
    if(typeof stn !== 'undefined'){
        return stn.decoratedCallsign;
    }
    return "["+callsign+"]";
}

function escapeChatHtml(text) {
  return $('<div>').text(text == null ? '' : String(text)).html();
}

function renderChatMessageHtml(text) {
  var source = text == null ? '' : String(text);
  var urlRegex = /(^|[\s(\[])((?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:[^\s<]*)?)/gi;

  return escapeChatHtml(source).replace(urlRegex, function(match, prefix, urlText) {
    var cleanUrl = urlText.replace(/[),.!?:;]+$/, '');
    var trailing = urlText.slice(cleanUrl.length);
    var href = cleanUrl;

    if (!/^https?:\/\//i.test(href)) {
      href = 'https://' + href;
    }

    return prefix + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + cleanUrl + '</a>' + trailing;
  });
}

//CR|3|1592759981|SP4MPB|Marek 23/13/3|0| jestes ?|SP6GWB|
//CH|3|1592770412|G1YFG |Robin 23cm   |0| test     |0|
function _isDuplicateMsg(log, message) {
  var from = message.from;
  var text = message.text;
  for (var i = log.length - 1; i >= 0; i--) {
    if (log[i].from === from && log[i].text === text) return true;
  }
  return false;
}
function procChatMessage(msg, isLive) {
  var message = new Message(msg);
  if (message.from.includes('SERVER')) {
    if (message.status == userName) {
      console.log("TO me: " + message.text);
      if (message.text.includes("Your name is now")) {
        $('#setNameAlert').hide();
        $('#setNameModal').modal('hide');
      }else if (message.text.includes("Invalid first name")) {
        $('#setNameAlert').show();
        $('#setNameAlertText').html("<strong>Warning: </strong> Invalid first name");
      }else if (message.text.includes("Available DX clusters")) {
        const regex = /Available DX clusters: (.+?)\./;
        const match = message.text.match(regex);
        if (match && match[1]) {
            clusterList = match[1].split(',').map(cluster => cluster.trim());
        } else {
          console.error('No DX clusters found in the text.');
        }
      }
    }
    return;
  }

  if (message.timestamp > latestMessageTime) {
    latestMessageTime = message.timestamp;
  }

  maybeAutoReplyWithLocator(message, isLive);

  var stn = stationList[message.from];

  var mf = message.from;
  if(mf.includes(userName)){
      mf = message.to;
  }
  var mt = message.to;
  if(mt.includes(userName)){
      mt = message.from;
  }
    
  var row = $("<tr>" +
    "<td>" + message.date + "</td>" +
    '<td class="from" onclick="chatPopup(\'' + mf + '\')" >' + decorate(message.from) + "</td>" +
    '<td class="to" onclick="chatPopup(\'' + mt + '\')"  >' + decorate(message.to) + "</td>" +
    "<td>" + renderChatMessageHtml(message.text) + "</td>" +
    "</tr>");

  row.data('fromCall', message.from);
  row.data('toCall', message.to);
    
  if (isLive) {
    $('#chatLog').prepend(row);
  } else {
    $('#chatLog').append(row);
  }

  if ($('#aboutMe').prop('checked')) {
    $('#chatLog >  tr').filter(":not(:icontains('" + userName + "'))").hide();
  }

  if (typeof stn !== 'undefined') {
    row.data('station', stn);
    row.data('distance', stn.distance);
    if (stn.distance > $('#maxDistance').val()) {
      row.hide();
    }
  }
  // messages for me
  if (message.to == userName) {
    row.addClass('table-danger');
    row.show();
    if (isLive) {
      playBeep();
    }
    if (typeof messageLog[message.from] == 'undefined') {
      messageLog[message.from] = [];
    }
    if (!_isDuplicateMsg(messageLog[message.from], message)) {
      if(isLive){
          messageLog[message.from].push(message);
          if (typeof ChatInbox !== 'undefined') ChatInbox.record(message, true);
      }else{
          messageLog[message.from].unshift(message);
      }
    }
    if (message.from == chatPopupCallsign) {
      appendToCurrentChat(message);
    }
  } else if (message.from == userName) {
    // messages from me
    if (typeof messageLog[message.to] == 'undefined') {
      messageLog[message.to] = [];
    }
    if (!_isDuplicateMsg(messageLog[message.to], message)) {
      if(isLive){
          messageLog[message.to].push(message);
          if (typeof ChatInbox !== 'undefined') ChatInbox.record(message, false);
      }else{
          messageLog[message.to].unshift(message);
      }
    }

    if (message.to == chatPopupCallsign) {
      appendToCurrentChat(message);
    }
  }
}

function statusUpdateChatLog(callsign){
  let dec = decorate(callsign);
  $("#chatLogTable tbody tr").each(function() {
    if ( $(this).data("toCall") === callsign) {
      $(this).find("td.to").text(dec);
    }else if($(this).data("fromCall") === callsign){
       $(this).find("td.from").text(dec);
    }
  });
}

function removeUser(msg) {
  var data = msg.split("|");
  var stn = stationList[data[2]];
  if (typeof stn !== 'undefined') {
    stn.marker.setMap(null);
    stn.setAway();
    statusUpdateChatLog(stn.callsign);
    var rowToRemove = dataTableUsers.row(function(idx, rowData, node) {
      return rowData.callsign === stn.callsign;
    });
    if (rowToRemove.any()) {
      rowToRemove.remove().draw();
      //delete stationList[data[2]];
    } else {
      console.log("User not found in the DataTable: " + data[2]);
    }
  }
}


function procUserStatus(msg) {
  var userData = msg.split("|");
  var callsign = userData[2];
  var state = userData[3];
  if (typeof stationList[callsign] != 'undefined') {
    if ((state & 0x01) == 0x01) {
      stationList[callsign].setAway();
      statusUpdateChatLog(callsign);
    } else {
      stationList[callsign].setBack();
      statusUpdateChatLog(callsign);
    }
    dataTableUsers.clear().rows.add(Object.values(stationList)).draw();
  }
}

// UA0|3|S51ZO|Joze 1,3-24GHZ|JN86DR|0|
function procUser(msg) {
  var stn = new Station(msg, myLatLong);
  if (stn.call == 'undefined') {
    return;
  }

  if (stn.isOK) {
    if (typeof stationList[stn.callsign] == 'undefined') {
      // New user to us ...
      stationList[stn.callsign] = stn;
      stn.lastSeen = Date.now();
      dataTableUsers.row.add(stn);
      $('#chatLog > tr').each(function(i, tr) {
        if ($(tr).data('fromCall') == stn.callsign) {
          $(tr).data('distance', stn.distance);
          $(tr).data('station', stn);
        }
      });
      statusUpdateChatLog(stn.callsign);
    } else{
      return;
    }
  } else {
    return;
  }
  dataTableUsers.draw();
  addMapMarker(stn);
}

function addMapMarker(stn) {
  var stnLoc = {
    lat: stn.lat,
    lng: stn.long
  };
  var marker = new google.maps.Marker({
    position: stnLoc,
    map: map,
    title: stn.decoratedCallsign
  });
  if (stn.isAway()) {
    marker.setIcon('https://maps.google.com/mapfiles/ms/icons/red-dot.png');
  } else {  
    marker.setIcon('https://maps.google.com/mapfiles/ms/icons/green-dot.png');
  }
  var contentString = '<div id="content">' +
    '<h4 id="firstHeading" class="firstHeading">' + stn.callsign + '</h1>' +
    '<div id="bodyContent">' +
    '<ul>' +
    '<li>' + stn.name + '</li>' +
    '<li>' + stn.locator + '</li>' +
    '<li>' + parseInt(stn.distance).toLocaleString() + 'km / ' + parseInt(stn.bearing) + '&#176;</li>' +
    '</ul>' +
    '<button onclick="chatPopup(\'' + stn.callsign + '\')">Chat</button>' +
    (stn.distance >= 5 && stn.distance <= 900 ? '<button onclick="setScatterTarget(\'' + stn.locator + '\',\'' + stn.callsign + '\')" style="margin-left:4px">&#9992; Scatter</button>' : '') +
    (window._rotatorUrl && stn.distance >= 1 ? '<button onclick="rotatorPointTo(\'' + stn.callsign + '\',\'' + stn.locator + '\')" style="margin-left:4px">&#x27f3; Rotate</button>' : '') +
    '</div>' +
    '</div>';

  var infowindow = new google.maps.InfoWindow({
    content: contentString
  });
  marker.addListener('click', function() {
    if (currentInfoWindow) {
      currentInfoWindow.close();
    }
    currentInfoWindow = infowindow;
    infowindow.open(map, marker);
    showProfile({
      lat: myLatLong[0],
      lng: myLatLong[1]
    }, stnLoc);
  });
  stn.infowindow = infowindow;
  stn.marker = marker;
  // Apply contest state to new marker
  if (typeof ContestLog !== 'undefined') {
    _applyContestMarker(stn.callsign, marker);
  }
}

function _applyContestMarker(callsign, marker) {
  if (!marker) return;
  var opacity = (typeof ContestLog !== 'undefined') ? ContestLog.getMapOpacity(callsign) : 1;
  if (opacity === 0) {
    marker.setMap(null);
  } else {
    if (!marker.getMap()) marker.setMap(map);
    marker.setOpacity(opacity);
  }
}

// Called by ContestLog when state changes — refreshes all station map markers
window.contestRefreshMapMarkers = function() {
  if (typeof stationList === 'undefined') return;
  Object.keys(stationList).forEach(function(call) {
    var stn = stationList[call];
    if (stn && stn.marker) _applyContestMarker(call, stn.marker);
  });
};

function procLoginError(msg) {
  $('#loginError').show();
  $("#loginModal").modal('show');
  // $('#userList').empty();
  dataTableUsers.clear();
  $('#chatLog').empty();
  var data = msg.split("|");
  $('#loginErrorMessage').text(data[2]);
}

// LOGSTAT|100|3|20040703a|24D900574EDF9A2F0CFF46C77E988787|0|Robin 23cm|Szemeti|IO82UJ|robin@redpoint.org.uk|
function procLogin(msg) {
  $("#loginModal").modal('hide');
  $('#loginError').hide();
  logUsage({user: userName, chat: chatId});
  if (typeof ContestLog !== 'undefined') {
    ContestLog.init(userName);
    refreshRemoteSyncNamespace().then(function(namespace) {
      if (namespace) {
        syncRemoteUserSettings();
      }
    });
  }
  if (connectState == 'login') {
    dataTableUsers.clear();
    //$('#userList').empty();
    $('#chatLog').empty();
    //sendMsg("SPR|2|");
    //sendMsg("SDXQ|" + chatId + "|1296001|99999999|");
    //sendMsg("SMAQ|" + chatId + "|1296001|99999999|");
    sendMsg("SDONE|" + chatId + "|");
    listClusters();
    setCluster("ON4KST-2");
  } else {
    sendMsg("SPR|2|");
    sendMsg("SDXQ|" + chatId + "|" + latestMessageTime + "|99999999|");
    sendMsg("SMAQ|" + chatId + "|" + latestMessageTime + "|99999999|");
    sendMsg("SDONE|" + chatId + "|");
  }


  var bandInfo = getBandDataById(chatId);
  if (!$('#maxDistance').val() > 0 && bandInfo) {
    $('#maxDistance').val(bandInfo.defaultDistance);
  }
  $('#scatter-band').toggle(chatId == '3');

  $('#connState').text(bandInfo.name);
  var userData = msg.split("|");
  setSessionKey(userData[4]);
  setUsername(userData[6], userData[7]);
  kstServerLoc = userData[8];
  setMyLocator(kstServerLoc);
  applyStoredPreciseLocator();
  fetchBeacons(bandInfo.min, bandInfo.max);
}

function setSessionKey(key) {
  sessionKey = key;
}

function setUsername(first, surname) {
  $('#setNameText').val(first);
}

function listClusters() {
  sendMsg("MSG|" + chatId + "|0|/LSTCLX|0|");
}

function setCluster(cluster) {
  sendMsg("MSG|" + chatId + "|0|/SETCLX "+cluster+"|0|");
}

function showCluster() {
  sendMsg("MSG|" + chatId + "|0|/SHCLX|0|");
}

function spotToCluster(spot) {
  const info = spot.report +" "+spot.spotter_locator+"<"+spot.mode+">"+spot.locator+" K2U";
  const msg = "MSG|" + chatId + "|0|/DX "+spot.freq+" "+spot.callsign+" "+info+"|0|";
  //alert(msg);
  spot.msg_text=msg;
  sendMsg(msg);
}

function setAway() {
  sendMsg("MSG|" + chatId + "|0|/AWAY|0|");
  stationList[userName].setAway();
  statusUpdateChatLog(userName); 
  dataTableUsers.clear().rows.add(Object.values(stationList)).draw();
}

function setBack() {
  sendMsg("MSG|" + chatId + "|0|/BACK|0|");
  stationList[userName].setBack();
  statusUpdateChatLog(userName); 
  dataTableUsers.clear().rows.add(Object.values(stationList)).draw();
}

function setName() {
  var name = $('#setNameText').val();
  sendMsg("MSG|" + chatId + "|0|/SETNAME " + name + "|0|");
}

function setMyLocator(loc, latLongOverride) {
  if (loc == myLoc) {
    if (latLongOverride) {
      myLatLong = latLongOverride;
      drawMap();
    }
    renderLocationSettings();
    return;
  }
  myLoc = loc;
  myLatLong = latLongOverride || gridSquareToLatLon(myLoc);
  drawMap();
  renderLocationSettings();
}

function sendMsg(msg) {
  console.log("> " + msg);
  $('#debugWindow').append("> " + msg + "\n<br/>");
  var myblob = new Blob([msg + "\r\n"], {
    type: 'text/plain'
  });
  ws.send(myblob);
}

function doLogin() {
    chatId = $('#chatId').val();
    userName = $('#userInput').val().toUpperCase();
    password = $('#passInput').val();
    if (typeof ChatInbox   !== 'undefined') ChatInbox.init(userName);
    if (typeof ContestLog  !== 'undefined') ContestLog.init(userName, password);

    if ($('#rememberMe').is(':checked')) {
        var cookieData = {
            user: userName,
            pass: password,
            chatId: chatId,
        };
        setCookie("kst2youUserDetails", JSON.stringify(cookieData), 90);
    } else {
        eraseCookie("kst2youUserDetails");
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('Closing existing WebSocket before login.');
        try {
            ws.close();
        } catch (e) {
            console.warn('Error closing WebSocket on login attempt:', e);
        }
        ws = null; // ✅ Clean start
    }

    connectState = 'login';  // <--- IMPORTANT
    connCount = 0;
    urlId = 0;               // <--- IMPORTANT
    websocketInit(websocketServerUrls);
}


function doLogoff() {
  $("#loginModal").modal({
    backdrop: 'static',
    keyboard: false
  });
  $('#loginError').hide();
  password = '';
  if (typeof ws != 'undefined') {
    ws.close();
  }
  deleteAllMapMarkers();
  deleteAllBeacons();
  stationList = {};
  latestMessageTime = 0;
  //$('#userList').empty();
  dataTableUsers.clear().draw();
  $('#chatLog').empty();
  $('#debugWindow').empty();
  $("#awayButton").prop('checked', false);
  connectState = 'logOff';
}

function initUserList() {
  dataTableUsers = $('#userListTable').DataTable({
    "paging": false,
    "order": [
      [3, "asc"]
    ],
    "ordering": true,
    "info": true,
    "data": userList,
    "columns": [{
        data: 'decoratedCallsign'
      },
      {
        data: 'name'
      },
      {
        data: 'locator'
      },
      {
        data: 'distance',
        type: 'num',
        render: function(data, type, row) {
          if (type == 'sort') return data;
          return parseInt(row.distance).toLocaleString() + ' / ' + parseInt(row.bearing) + '\u{00B0}';
        }
      },
      {
        data: 'lastSeen',
        type: 'num',
        render: function(data, type, row) {
          if (type == 'sort') return data;
          var d = new Date(data);
          return d.toLocaleDateString() + '  ' + d.toLocaleTimeString();
        }
      },
    ],
    createdRow: function(row, data) {
      $(row).attr('data-callsign', data.callsign);
      if (typeof ContestLog !== 'undefined' && ContestLog.isActive()) {
        var state = ContestLog.getState(data.callsign);
        if (state) {
          var display = state === 'worked' ? ContestLog.getSetting('workedDisplay') : ContestLog.getSetting('skipDisplay');
          if (display === 'hide') { $(row).hide(); }
          else { $(row).addClass('clog-greyed'); }
        }
      }
    },
  });

  $('#userListTable tbody').on('click', 'tr', function(e) {
    if ($(e.target).closest('button').length) return;
    chatPopup(dataTableUsers.row(this).data().callsign);
  });
}

function filterChatByDistance() {
  var dist = $('#maxDistance').val();
  var uname = userName.toLowerCase();

  $('#chatLog > tr').each(function(index, tr) {
    var $tr = $(tr);
    var distance = $tr.data('distance');
    var rowText = $tr.text().toLowerCase();

    // Always show rows that mention the current user
    if (rowText.includes(uname)) {
      $tr.show();
    } else if (typeof distance !== 'undefined' && distance > dist) {
      $tr.hide();
    } else {
      $tr.show();
    }
  });
}


function chatPopup(callsign) {
  if (callsign === '0') {
    return;
  }
  chatPopupCallsign = callsign;
  if (typeof ChatInbox !== 'undefined') ChatInbox.markRead(callsign);
  var _meta = (typeof ChatInbox !== 'undefined') ? ChatInbox.getMeta(callsign) : null;
  var _distb = '', _distance = 9999;
  if (_meta && _meta.locator && typeof gridSquareToLatLon === 'function') {
    try {
      var _ll = gridSquareToLatLon(_meta.locator);
      _distance = Math.round(distVincenty(myLatLong[0], myLatLong[1], _ll[0], _ll[1]) / 1000);
      _distb    = _distance + 'km / ' + Math.round(bearing(myLatLong[0], myLatLong[1], _ll[0], _ll[1])) + '°';
    } catch(e) {}
  }
  var chatUser = stationList[callsign] || {
    decoratedCallsign: callsign,
    name:      _meta ? _meta.name    : '',
    locator:   _meta ? _meta.locator : '',
    distb:     _distb,
    _distance: _distance,
  };
  $('#chatWindow').empty();
  $('#chatPopupMessageInput').empty();
  $('#chatPopupUser').text(chatUser.decoratedCallsign + (chatUser.name ? ' ' + chatUser.name : ''));
  var isOnline = !!stationList[callsign];
  $('#chatPopupLocator').text(chatUser.locator || '').css('color', '');
  $('#chatPopupBearing').text(chatUser.distb  || '').css('color', '');
  $('#chatLocationUL').off('click').click(function(){
     showOnMap(chatUser);
  });
  var $scatterWrap = $('#chatPopupScatterWrap');
  if (chatUser.locator && chatUser._distance >= 5 && chatUser._distance <= 900) {
    $scatterWrap.show();
    $('#chatPopupScatterButton').off('click').on('click', function(e) {
      e.stopPropagation();
      bootstrap.Modal.getInstance(document.getElementById('modalChat')).hide();
      window.setScatterTarget(chatUser.locator, callsign);
    });
  } else {
    $scatterWrap.hide();
  }
  var $rotWrap = $('#chatPopupRotateWrap');
  if (window._rotatorUrl && chatUser.locator) {
    $rotWrap.show();
    $('#chatPopupRotateButton').off('click').on('click', function(e) {
      e.stopPropagation();
      window.rotatorPointTo(callsign, chatUser.locator);
    });
  } else {
    $rotWrap.hide();
  }
  // Contest mark buttons
  var $contestWrap = $('#chatContestWrap');
  if (typeof ContestLog !== 'undefined' && ContestLog.isActive()) {
    $contestWrap.show();
    var _cstate = ContestLog.getState(callsign);
    var $badge = $('#chatContestBadge');
    $badge.text(_cstate === 'worked' ? '✓ Worked' : _cstate === 'skip' ? '✗ Skip' : '');
    $badge.attr('class', 'chat-contest-badge ms-1' + (_cstate ? ' clog-' + _cstate : ' d-none'));
    var _brg = chatUser.locator ? Math.round(bearing(myLatLong[0], myLatLong[1],
      gridSquareToLatLon(chatUser.locator)[0], gridSquareToLatLon(chatUser.locator)[1])) : null;
    $('#chatWorkedButton').off('click').on('click', function(e) {
      e.stopPropagation();
      if (ContestLog.getSetting('exchangeMode') === 'exchange') {
        // Populate and show the exchange modal
        $('#cex-callsign').text(callsign);
        $('#cex-locator').val(chatUser.locator || '');
        $('#cex-rst-sent').val('59');
        $('#cex-serial-sent').val(ContestLog.getNextSerial());
        $('#cex-rst-rcvd').val('59');
        $('#cex-serial-rcvd').val('');
        $('#cex-comments').val('');
        var cexModal = new bootstrap.Modal(document.getElementById('contestExchangeModal'));
        cexModal.show();
        document.getElementById('contestExchangeModal').addEventListener('shown.bs.modal', function() {
          document.getElementById('cex-serial-rcvd').focus();
        }, { once: true });
        // Wire the Log button (re-bind each time)
        $('#cex-log-btn').off('click').on('click', function() {
          var locOverride = ($('#cex-locator').val() || '').trim();
          var exchange = {
            rstSent:    $('#cex-rst-sent').val(),
            serialSent: ContestLog.consumeSerial($('#cex-serial-sent').val()),
            rstRcvd:    $('#cex-rst-rcvd').val(),
            serialRcvd: $('#cex-serial-rcvd').val(),
            comments:   ($('#cex-comments').val() || '').trim()
          };
          ContestLog.mark(callsign, 'worked', locOverride || chatUser.locator, chatUser._distance, _brg, exchange);
          cexModal.hide();
        });
      } else {
        // Simple mode — mark immediately
        ContestLog.mark(callsign, 'worked', chatUser.locator, chatUser._distance, _brg);
      }
    });
    $('#chatSkipButton').off('click').on('click', function(e) {
      e.stopPropagation();
      ContestLog.mark(callsign, 'skip', chatUser.locator, chatUser._distance, _brg);
    });
  } else {
    $contestWrap.hide();
  }
  $('#chatPopupMessageInput').prop('disabled', !isOnline)
    .attr('placeholder', isOnline ? 'Write your message' : 'Station offline — history only');
  $('#chatPopupSendButton').prop('disabled', !isOnline);
  $('#chatPopupSendLocButton').prop('disabled', !isOnline || !getLocatorForChatShare());
  $('#chatPopupSendLocButton').off('click').on('click', function() {
    if (sendLocatorToCallsign(callsign)) {
      $('#chatPopupMessageInput').focus();
    }
  });
  if (!isOnline) {
    $('#chatWindow').append(
      '<div style="text-align:center;padding:6px 10px;margin-bottom:6px;' +
      'background:#fff3f3;border:1px solid #f5c6cb;border-radius:4px;' +
      'color:#dc3545;font-size:11px;font-weight:600;letter-spacing:1px">' +
      '⚠ OFFLINE — message history only</div>'
    );
  }
  $('#modalChat').modal('show');
  if (isOnline) $('#chatPopupMessageInput').focus();
  if (typeof messageLog[callsign] !== 'undefined') {
    messageLog[callsign].sort(function(a, b) {
      var ta = (typeof a.timestamp !== 'undefined') ? a.timestamp : a.ts;
      var tb = (typeof b.timestamp !== 'undefined') ? b.timestamp : b.ts;
      if (ta > 9999999999) ta = Math.floor(ta / 1000);
      if (tb > 9999999999) tb = Math.floor(tb / 1000);
      return ta - tb;
    });
    messageLog[callsign].forEach(showChatHistory);
  }
}

function showOnMap(user){
    if (currentInfoWindow) {
      currentInfoWindow.close();
    }
    currentInfoWindow = user.infowindow;
    user.infowindow.open(map, user.marker);
    $('#mapTab a').tab('show');
    showProfile(
    {
      lat: myLatLong[0],
      lng: myLatLong[1]
    }, 
    {
      lat: user.latLong[0],
      lng: user.latLong[1] 
    }
  );
}

function showChatHistory(msg, ix, array) {
  appendToCurrentChat(msg);
}

function appendToCurrentChat(msg) {
  var m = $('<p class="text-muted margenesCompletas10px"><strong class="text-primary">' + msg.from + ':</strong>&nbsp;' + renderChatMessageHtml(msg.text) + '</p>');
  $('#chatWindow').append(m);
  $("#chatWindow").scrollTop($("#chatWindow").prop("scrollHeight"));
}

jQuery.expr[':'].icontains = function(a, i, m) {
  return jQuery(a).text().toUpperCase()
    .indexOf(m[3].toUpperCase()) >= 0;
};

function initCqList() {
  try {
    const storedData = localStorage.getItem('cqMesgList');
    cqMesgList = JSON.parse(storedData);

    if (Array.isArray(cqMesgList)) {
      $('#cqMesgSelector').empty();
      // Your other initialization code here
    } else {
      cqMesgList = [];
      localStorage.setItem('cqMesgList', JSON.stringify(cqMesgList));
    }
  } catch (error) {
    // Handle JSON parsing errors here
    console.error('Error parsing cqMesgList:', error);
    cqMesgList = [];
    localStorage.setItem('cqMesgList', JSON.stringify(cqMesgList));
  }
}

function sendCqMesg() {
  var msgText = $('#cqMesgText').val().trim();
  if (!cqMesgList.includes(msgText)) {
    cqMesgList.unshift(msgText);
    while (cqMesgList.length > 10) {
      cqMesgList.pop(); // Remove the oldest message from the end
    }
    localStorage.setItem('cqMesgList', JSON.stringify(cqMesgList));
  }
  sendMsg("MSG|" + chatId + "|0|" + msgText + "|0|");
  $('#cqModal').modal('hide');
}

function cqModalShow() {
  $('#cqMesgSelector').empty();

  // Add a default placeholder option
  $('#cqMesgSelector').append($('<option>', {
    value: '',
    text: 'Choose a message',
    disabled: true,
    selected: true // This will make it selected by default
  }));

  if (cqMesgList.length === 0) {
    $('#cqDropDownRow').hide();
  } else {
    cqMesgList.forEach(function (item, index) {
      $('#cqMesgSelector').append($('<option>', {
        value: index,
        text: item
      }));
    });
    $('#cqDropDownRow').show();
  }
  $('#cqModal').modal('show');
}


function sendChat() {
  var txt = $('#chatPopupMessageInput').val();
  if (txt.length > 0) {
    $('#chatPopupMessageInput').val('');
    //alert(txt);
    sendMsg("MSG|" + chatId + "|0|/CQ " + chatPopupCallsign + " " + txt + "|0|");
  }
}

$(document).ready(function() {
  renderReleaseTag();
  if (typeof ChatInbox !== 'undefined') ChatInbox.buildUI();
  if ((location.protocol !== 'https:') && (location.hostname != "127.0.0.1")) {
      location.replace(`https:${location.href.substring(location.protocol.length)}`);
  }
  if (typeof initMap === "function") {
        // Dynamically load the Google Maps API.
        var script = document.createElement('script');
        script.src = "https://maps.googleapis.com/maps/api/js?key=AIzaSyA609pI75YFCN-uINIw89OXESRxv56Btpk&callback=initMap";
        document.body.appendChild(script);
  } else {
        console.error("initMap function is not defined!");
  }
  initUserList();
  initCqList();

  $('#chatId').empty();
  var optgroup = $('<optgroup>').attr('label', 'Select Chat Group'); 
  $.each(chatGroups, function(index, chatGroup) {
    var option = $('<option>')
        .attr('value', chatGroup.id)
        .text(chatGroup.name)
        .data('min', chatGroup.min)
        .data('max', chatGroup.max)
        .data('defaultDistance', chatGroup.defaultDistance);
    
     optgroup.append(option);
  });

  $('#chatId').append(optgroup);  
    
  var cookie = getCookie("kst2youUserDetails");
  if (typeof cookie != 'undefined') {
    try {
      var cookieData = JSON.parse(cookie);
      $('#userInput').val(cookieData.user);
      $('#passInput').val(cookieData.pass);
      $("#rememberMe").prop('checked', true);
      if (cookieData.chatId !== null && cookieData.chatId !== undefined) {
         $('#chatId option[value="' + cookieData.chatId + '"]').prop('selected', true);
      }else{
         $('#chatId option[value="3"]').prop('selected', true);
      }
    } catch (e) {
      $('#chatId option[value="3"]').prop('selected', true);
    }
  } else {
    $("#rememberMe").prop('checked', false);
    $('#chatId option[value="3"]').prop('selected', true);
  }
    

  $('#loginModal').modal({
    backdrop: 'static',
    keyboard: false
  })
  $('#loginError').hide();
  $('#registerButton').click(function() {
    doLogin();
  });
  $('#logOffButton').click(function() {
    doLogoff();
  });
  $('#cqButton').click(function() {
    cqModalShow();
  });  
    
  $('#setNameButton').click(function() {
    $('#setNameModal').modal('show');
  });

  $('#setNameAlert').hide();

  $('#sendSetNameButton').click(function() {
    setName();
  });

  $('#beepTestButton').click(function() {
    playBeep();
  });

  $('#planeAlertTestButton').click(function() {
    if (typeof window.playPlaneAlert === 'function') window.playPlaneAlert();
  });

  // ── Contest mode settings UI ──────────────────────────
  // Sync dropdowns when Settings tab opens
  $('a[href="#tab-settings"]').on('shown.bs.tab', function() {
    renderLocationSettings();

    // Rotator settings
    var rotType = localStorage.getItem('kst2you_rotator_type') || 'auto';
    var rotPort = localStorage.getItem('kst2you_rotator_port') || '';
    $('#settings-rotator-type').val(rotType);
    $('#settings-rotator-port').val(rotPort);
    $('#settings-rotator-port-wrap').toggle(rotType === 'custom' || rotType === 'pstrotator');
    $('#settings-rotator-hint').toggle(rotType === 'auto');

    // Contest settings
    if (typeof ContestLog === 'undefined') return;
    var active = ContestLog.isActive();
    $('#contest-mode-active').prop('checked', active);
    $('#contest-worked-display').val(ContestLog.getSetting('workedDisplay'));
    $('#contest-skip-display').val(ContestLog.getSetting('skipDisplay'));
    $('#contest-map-display').val(ContestLog.getSetting('mapDisplay'));
    $('#contest-exchange-mode').val(ContestLog.getSetting('exchangeMode') || 'simple');
    $('.contest-settings-detail').toggle(active);
  });
  $('a[href="#tab-contest"]').on('shown.bs.tab', function() {
    if (typeof ContestLog !== 'undefined') ContestLog.renderLogTab();
  });
  $('#contest-mode-active').on('change', function() {
    if (typeof ContestLog !== 'undefined') ContestLog.setActive(this.checked);
    $('.contest-settings-detail').toggle(this.checked);
  });
  $('#contest-worked-display').on('change', function() {
    if (typeof ContestLog !== 'undefined') ContestLog.setSetting('workedDisplay', this.value);
  });
  $('#contest-skip-display').on('change', function() {
    if (typeof ContestLog !== 'undefined') ContestLog.setSetting('skipDisplay', this.value);
  });
  $('#contest-map-display').on('change', function() {
    if (typeof ContestLog !== 'undefined') ContestLog.setSetting('mapDisplay', this.value);
  });
  $('#contest-exchange-mode').on('change', function() {
    if (typeof ContestLog !== 'undefined') ContestLog.setSetting('exchangeMode', this.value);
  });

  // ── Rotator settings ────────────────────────────────
  $('#settings-rotator-type').on('change', function() {
    var type = this.value;
    localStorage.setItem('kst2you_rotator_type', type);
    $('#settings-rotator-port-wrap').toggle(type === 'custom' || type === 'pstrotator');
    $('#settings-rotator-hint').toggle(type === 'auto');
    if (type === 'none') {
      window._rotatorUrl = null;
      window._rotatorType = null;
      var el = document.getElementById('scatter-rotator-status');
      if (el) { el.textContent = 'Rotator: disabled'; el.style.opacity = '.5'; el.style.color = ''; }
    } else {
      window._applyRotatorSetting();
    }
    _saveRotatorToCloud();
  });
  $('#settings-rotator-port').on('change', function() {
    localStorage.setItem('kst2you_rotator_port', this.value);
    window._applyRotatorSetting();
    _saveRotatorToCloud();
  });
  $('#settings-clear-precise-locator').on('click', function() {
    setStoredPreciseLocator('', true);
    if (kstServerLoc) {
      setMyLocator(kstServerLoc);
    }
  });
  $('#settings-sync-remote-storage').on('change', function() {
    setRemoteSettingsSyncEnabled(this.checked);
  });
  $('#settings-download-remote-data').on('click', async function() {
    if (typeof ContestLog === 'undefined' || !ContestLog.downloadRemoteBackup) return;
    try {
      await ContestLog.downloadRemoteBackup();
    } catch (error) {
      alert(error && error.message ? error.message : 'Unable to download remote data.');
    }
  });
  $('#settings-delete-remote-data').on('click', function() {
    if (typeof ContestLog === 'undefined' || !ContestLog.deleteRemoteBackup) return;
    if (!confirm('Delete the current remote backup set?\nThis removes backed-up settings and contest sessions for the current credential-derived namespace only.')) {
      return;
    }
    ContestLog.deleteRemoteBackup(function(resp) {
      if (!resp || resp.status !== 'ok') {
        alert('Failed to delete remote data: ' + (resp && resp.message ? resp.message : 'network error'));
        return;
      }
      alert('Remote backup data deleted.');
    });
  });
  $('#settings-autoresponder-loc').on('change', function() {
    setLocAutoReplyEnabled(this.checked, true);
  });
  function _saveRotatorToCloud() {
    if (isRemoteSettingsSyncEnabled() && typeof ContestLog !== 'undefined' && ContestLog.getSetting) {
      ContestLog.saveUserSetting({
        rotatorType: localStorage.getItem('kst2you_rotator_type') || 'auto',
        rotatorPort: localStorage.getItem('kst2you_rotator_port') || ''
      });
    }
  }

  $("#chatPopup").on('shown.bs.modal', function() {
    $(this).find('#chatPopupMessageInput').focus();
  });

  $('#sendCqButton').click(function() {
    sendCqMesg();
  });

  $('#cqMesgSelector').change(function() { 
      $('#cqMesgText').val(cqMesgList[$(this).val()]);
  });

  $('#loginModal').keyup(function(e) {
    if (e.keyCode == 13) {
      doLogin();
    }
  });

  $('#aboutMe').change(function() {
    if (this.checked) {
      $('#chatLog > tr').filter(":not(:icontains('" + userName + "'))").hide();
    } else {
      $('#chatLog > tr').filter(":not(:icontains('" + userName + "'))").show();
      filterChatByDistance();
    }
  });

  $('#awayButton').change(function() {
    if (this.checked) {
      setAway();
    } else {
      setBack();
    }
  });

  $('#maxDistance').change(function() {
    filterChatByDistance();
  });

  $('#chatPopupSendButton').click(function() {
    sendChat();
    $('#chatPopupMessageInput').focus();
  });

  $('#chatPopupSpotButton').off('click').on('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof spotPopupUser === 'function') {
      spotPopupUser(chatPopupCallsign);
    }
    return false;
  });

  $('#modalChat').on('shown.bs.modal', function() {
    $('#chatPopupMessageInput').focus();
  });

  $('#chatPopupMessageInput').on('keydown', function(e) {
      if (e.keyCode == 13) { // Check if the pressed key is Enter
        sendChat();
        if (e.preventDefault) {
          e.preventDefault();
        } else {
          e.returnValue = false;
        }
        return false;
      }
  });
    
 // $('#cqModal').on('shown.bs.modal', function() {
 //   $('#cqMesgText').focus();
 // });
    
  $('#cqMesgText').on('keydown', function(e) {
      if (e.keyCode == 13) {
        sendCqMesg();
        if (e.preventDefault) {
          e.preventDefault();
        } else {
          e.returnValue = false;
        }
        return false;
      }
  });

  $("#gridButton").click(function(){
     if(gridActive){
        setGridOff();
     }else{
        setGridOn();
     }
  });
    
  $("#circlesButton").click(function(){
     if(circlesActive){
        setCirclesOff();
     }else{
        setCirclesOn();
     }
  });
    
  $('#setLocation').click(function() {
     if (!newLocation) {
      return;
     }

     kstServerLoc = newLocation.gs.substring(0, 6);
     setStoredPreciseLocator(newLocation.gs, true);
     setMyLocator(newLocation.gs, [newLocation.lat, newLocation.lng]);
     sendMsg("MSG|" + chatId + "|0|/SETLOC " + kstServerLoc + "|0|");
    $('#locationModal').modal('hide');
  });
    
  $('[data-toggle="tooltip"]').tooltip(); 

  $('#chatTab a').tab('show');

  var supportsWebSockets = 'WebSocket' in window || 'MozWebSocket' in window;

  if (!supportsWebSockets) {
    alert("Your browser does not appear to support WebSockets, we use these for communication with the server. Can I suggest you try Google Chrome?");
  }
});

function setCookie(name, value, days) {
  var expires = "";
  if (days) {
    var date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000))
    expires = "; expires=" + date.toUTCString() + "; SameSite=None; Secure";
  }
  document.cookie = name + "=" + (value || "") + expires + "; path=/";
}

function getCookie(name) {
  var nameEQ = name + "=";
  var ca = document.cookie.split(';');
  for (var i = 0; i < ca.length; i++) {
    var c = ca[i];
    while (c.charAt(0) == ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

function eraseCookie(name) {
  document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=None; Secure';
}

function degToDegMin(decimalDegrees) {
  if (isNaN(decimalDegrees)) {
    return "Invalid input";
  }

  const degrees = Math.floor(decimalDegrees);
  const decimalPortion = decimalDegrees - degrees;
  const minutes = decimalPortion * 60;

  return `${degrees}° ${minutes.toFixed(2)}'`;
}