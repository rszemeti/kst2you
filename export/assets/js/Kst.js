var settings = [];
var debug;
var ws;
var connectState;

const websocketServerUrl = "wss://live2.live-bidder.com/kst/"

var lastMsg;
var latestMessageTime = 0;
var lastError;
var rawMsg;

var reader;
var newlocation; // gridsqaure stored for set lat/long
var myLoc;
var myLatLong;
var sessionKey;
var map;
var stationList = {};
var messageLog = {}
var chatPopupCallsign;
var ngList;

var chatId;
var userName;
var password;

var userList = [];
const locTest = RegExp('\w{6}');

const chatGroups = [
    {id: '10', name: 'kHz (2000 m - 630 m)', min: 0, max: "1", defaultDistance: 20000},
    {id: "4", name: 'low band (160 m - 40 m)', min: 1, max: "8", defaultDistance: 20000},
    {id: '12', name: '28 MHz chat', min: 27, max: 29, defaultDistance: 20000},
    {id: '11', name: 'WARC (30 m, 17 m, 12 m)', min: 5, max: 30, defaultDistance: 20000},
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
  }

  setBack() {
    this._isAway = false;
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
    this._to = msg[7];
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



function websocketInit(url) {
  debug = true;
  ws = new ReconnectingWebSocket(url);
  ws.binaryType = "blob";

  ws.onmessage = function(msg) {
    rawMsg = msg;
    var reader = new FileReader();

    reader.addEventListener('loadend', (e) => {
      const text = e.srcElement.result;
      lastMsg = text;
      procMsgs(text);
    });
    reader.readAsText(msg.data, 'ISO-8859-1');

  };

  ws.onopen = function() {
    $('#connState').text("connected");
    sendMsg("LOGINC|" + userName + "|" + password + "|" + chatId + "|KST2You 1.0|20|20|1|" + latestMessageTime + "|" + latestMessageTime + "|");
  };

  ws.onclose = function() {
    if (connectState == 'logOff') {
      $('#connState').text('connection closed');
      $("#loginModal").modal();
    } else {
      connectState = 'relog';
      $('#connState').text('re-connecting');
    }
  };

  ws.onerror = function(evt) {
    lastError = evt;
    procWsError(evt)
  };

}

function procWsError(evt) {
  $('#loginError').show();
  $("#loginModal").modal('show');
  $('#loginErrorMessage').text("Unable to connect to " + evt.target.url);
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

//CR|3|1592759981|SP4MPB|Marek 23/13/3|0| jestes ?|SP6GWB|
//CH|3|1592770412|G1YFG |Robin 23cm   |0| test     |0|
function procChatMessage(msg, isLive) {
  var message = new Message(msg);
  if (message.from.includes('SERVER')) {
    if (message.status == userName) {
      console.log("TO me: " + message.text);
      if (message.text.includes("Your name is now")) {
        $('#setNameAlert').hide();
        $('#setNameModal').modal('hide');
      }
      if (message.text.includes("Invalid first name")) {
        $('#setNameAlert').show();
        $('#setNameAlertText').html("<strong>Warning: </strong> Invalid first name");
      }
    }
    return;
  }

  if (message.timestamp > latestMessageTime) {
    latestMessageTime = message.timestamp;
  }

  var stn = stationList[message.from];

  var row = $("<tr>" +
    "<td>" + message.date + "</td>" +
    '<td class="from" onclick="chatPopup(\'' + message.from + '\')" >' + decorate(message.from) + "</td>" +
    '<td class="to" onclick="chatPopup(\'' + message.to + '\')"  >' + decorate(message.to) + "</td>" +
    "<td>" + message.text + "</td>" +
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
    if(isLive){
        messageLog[message.from].push(message);
    }else{
        messageLog[message.from].unshift(message); 
    }
    if (message.from == chatPopupCallsign) {
      appendToCurrentChat(message);
    }
  } else if (message.from == userName) {
    // messages from me
    if (typeof messageLog[message.to] == 'undefined') {
      messageLog[message.to] = [];
    }
    if(isLive){
        messageLog[message.to].push(message);
    }else{
        messageLog[message.to].unshift(message); 
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
      stationList[stn.callsign] = stn;
      stn.lastSeen = Date.now();
    } else {
      return;
    }
    console.log("assigning data to " + stn.callsign);
    dataTableUsers.row.add(stn);
    $('#chatLog > tr').each(function(i, tr) {
      if ($(tr).data('fromCall') == stn.callsign) {
        $(tr).data('distance', stn.distance);
        $(tr).data('station', stn);
      }
    });
    statusUpdateChatLog(stn.callsign);
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
    title: stn.callsign
  });
  var contentString = '<div id="content">' +
    '<h4 id="firstHeading" class="firstHeading">' + stn.callsign + '</h1>' +
    '<div id="bodyContent">' +
    '<ul>' +
    '<li>' + stn.name + '</li>' +
    '<li>' + stn.locator + '</li>' +
    '<li>' + parseInt(stn.distance).toLocaleString() + 'km / ' + parseInt(stn.bearing) + '&#176;</li>' +
    '</ul>' +
    '<button onclick="chatPopup(\'' + stn.callsign + '\')">Chat</button>' +
    '</div>' +
    '</div>';

  var infowindow = new google.maps.InfoWindow({
    content: contentString
  });
  marker.addListener('click', function() {
    infowindow.open(map, marker);
    showProfile({
      lat: myLatLong[0],
      lng: myLatLong[1]
    }, stnLoc);
  });

  stn.marker = marker;
}

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
  if (connectState == 'login') {
    dataTableUsers.clear();
    //$('#userList').empty();
    $('#chatLog').empty();
    //sendMsg("SPR|2|");
    //sendMsg("SDXQ|" + chatId + "|1296001|99999999|");
    //sendMsg("SMAQ|" + chatId + "|1296001|99999999|");
    sendMsg("SDONE|" + chatId + "|");
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

  $('#connState').text(bandInfo.name);
  var userData = msg.split("|");
  setSessionKey(userData[4]);
  setUsername(userData[6], userData[7]);
  setMyLocator(userData[8]);
  fetchBeacons(bandInfo.min, bandInfo.max);
}

function setSessionKey(key) {
  sessionKey = key;
}

function setUsername(first, surname) {
  $('#setNameText').val(first);
}

function setAway() {
  sendMsg("MSG|" + chatId + "|0|/AWAY|0|");
  stationList[userName].setAway();
  statusUpdateChatLog(userName); dataTableUsers.clear().rows.add(Object.values(stationList)).draw();
}

function setBack() {
  sendMsg("MSG|" + chatId + "|0|/BACK|0|");
  stationList[userName].setBack();
  statusUpdateChatLog(userName); dataTableUsers.clear().rows.add(Object.values(stationList)).draw();
}

function setName() {
  var name = $('#setNameText').val();
  sendMsg("MSG|" + chatId + "|0|/SETNAME " + name + "|0|");
}

function setMyLocator(loc) {
  if (loc == myLoc) {
    return;
  }
  myLoc = loc;
  myLatLong = gridSquareToLatLon(myLoc);
  drawMap();
}

function sendMsg(msg) {
  console.log("> " + msg);
  $('#debugWindow').append("> " + msg + "\n<br/>");
  var myblob = new Blob([msg + "\r\n"], {
    type: 'text/plain'
  });
  ws.send(myblob);
}

//ws.open();
function doLogin() {
  chatId = $('#chatId').val();
  userName = $('#userInput').val().toUpperCase();
  password = $('#passInput').val();
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
  connectState = 'login';
  websocketInit(websocketServerUrl);
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

var dataTableUsers;

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
      }
    ],
  });

  $('#userListTable tbody').on('click', 'tr', function() {
    chatPopup(dataTableUsers.row(this).data().callsign);
  });
}

function filterChatByDistance() {
  var dist = $('#maxDistance').val();
  $('#chatLog > tr').each(function(index, tr) {
    if (typeof $(tr).data('distance') == 'undefined') {
      // sigh ... 
    } else if ($(tr).data('distance') > dist) {
      $(tr).hide();
    } else {
      $(tr).show();
    }
  });
}

function chatPopup(callsign) {
  if (callsign === '0') {
    return;
  }
  chatPopupCallsign = callsign;
  var chatUser = stationList[callsign];
  $('#chatWindow').empty();
  $('#chatPopupMessageInput').empty();
  $('#chatPopupUser').text(chatUser.decoratedCallsign + " " + chatUser.name);
  $('#chatPopupLocator').text(chatUser.locator);
  $('#chatPopupBearing').text(chatUser.distb);
  $('#modalChat').modal('show');
  $('#chatPopupMessageInput').focus();
  if (typeof messageLog[callsign] !== 'undefined') {
    messageLog[callsign].forEach(showChatHistory);
  }
}

function showChatHistory(msg, ix, array) {
  appendToCurrentChat(msg);
}

function appendToCurrentChat(msg) {
  var m = $('<p class="text-muted margenesCompletas10px"><strong class="text-primary">' + msg.from + ':</strong>&nbsp;' + msg.text + '</p>');
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
    cqMesgList.unshift(msgText);y
    while (cqMesgList.length > 10) {
      cqMesgList.pop(); // Remove the oldest message from the end
    }
    localStorage.setItem('cqMesgList', JSON.stringify(cqMesgList));
    sendMsg("MSG|" + chatId + "|0|" + msgText + "|0|");
    //console.log("MSG|" + chatId + "|0|" + msgText + "|0|");
  }
  $('#cqModal').modal('hide');
}


function cqModalShow() {
  $('#cqMesgSelector').empty();
  if (cqMesgList.count == 0) {
    $('#cqDropDownRow').hide();
  } else {
    cqMesgList.forEach(function(item, index) {
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

  $('#modalChat').on('shown.bs.modal', function() {
    $('#chatPopupMessageInput').focus();
  });

  $('#chatPopupMessageInput').on('keydown', function(e) {
      if (e.keyCode == 13) { // Check if the pressed key is Enter
        e.preventDefault();
        sendChat();
        return false; // Prevent the default behavior of the Enter key
      }
  });
    
  $('#cqModal').on('shown.bs.modal', function() {
    $('#cqMesgText').focus();
  });
    
  $('#cqMesgText').on('keydown', function(e) {
      if (e.keyCode == 13) {
        e.preventDefault();
        console.log("sending CQ ... "+e.keyCode);
        sendCqMesg();
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
    myLoc = newLocation.gs;
    myLatLong = [newLocation.lat, newLocation.lng];
    sendMsg("MSG|" + chatId + "|0|/SETLOC " + myLoc + "|0|");
    $('#locationModal').modal('hide');
    drawMap();
  });

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