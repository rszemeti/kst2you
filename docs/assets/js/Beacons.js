var beacons = {}; // Use an object instead of an array
var beaconStates={};

var spotList = [];
var dataTableSpots;

var spotBcn;

const reportPattern = /^[1-5][1-9]{1,2}$|^[+-]?\s*[1-9][0-9]?\s*[dD][bB]$/;

const modes = [
    { value: "TR", text: "Tropo" },
    { value: "AS", text: "Aircraft Scatter" },
    { value: "MS", text: "Meteor Scatter" },
    { value: "RS", text: "Rain Scatter" },
    { value: "SS", text: "Snow Scatter" },
    { value: "ES", text: "Sporadic E" },
    { value: "F2", text: "F2 layer" },
    { value: "TEP", text: "Trans-Equatorial" },
    { value: "AU", text: "Aurora" },
    { value: "EME", text: "EME"}
];

function fetchBeacons(min,max) {
   deleteAllBeacons();
   beacons={};
   beaconStates={};
   var url = 'https://storage.googleapis.com/kst2you/BeaconList.json';
   
   $.getJSON(url, function (data) {
        data.forEach(function (item) {
            let frequencyKey = parseInt(item.frequency);
            if ((frequencyKey >= min) && (frequencyKey <= max)) {
                const roundedKey = Math.floor(frequencyKey);

                if (!beacons[roundedKey]) {
                    beacons[roundedKey] = {};
                }
                beacons[roundedKey][item.callsign] = item;
                for (let i = 1; i <= 2; i++) {
                    let j = roundedKey - i;
                    if (beacons[j]) {
                        for (const callsign in beacons[roundedKey]) {
                            beacons[j][callsign] = beacons[roundedKey][callsign];
                        }
                        delete beacons[roundedKey];
                    }
                }
            }

        });
        $('#bandList .bandButton').remove();
        var sortedKeys = Object.keys(beacons).map(Number).sort(function (a, b) {
            return a - b;
        });
        sortedKeys.forEach(function (key) {
            var button = $('<button></button>').text(key).attr('id', "bcnButton"+key);
            button.addClass('btn btn-secondary btn-group-vertical bandButton');
            // Add a click event listener to the button
            button.click(function () {
                toggleBeacons(key);
            });
            $('#bandList').append(button);
        });
    })
    .fail(function () {
        console.error('Error fetching data.');
    });
}

function toggleBeacons(key) {
    if (beaconStates[key] === 'hide') {
        hideBeacons(key);
        beaconStates[key] = 'show';
        $('#bcnButton' + key).removeClass('active');
        $('#bcnButton' + key).css('background-color', '');
    } else {
        showBeacons(key);
        beaconStates[key] = 'hide';
        $('#bcnButton' + key).addClass('active');
        $('#bcnButton' + key).css('background-color', '#03B703');
    }
}

function showBeacons(key){
    var list = beacons[key];
    for(i in list){
    addBeacon(beacons[key][i], key);
    }    
}

function hideBeacons(key) {
    var list = beacons[key];
    for (var i in list) {
    hideBeaconMarker(beacons[key][i], 'marker');
    hideBeaconMarker(beacons[key][i], 'scatterMarker');
    }
}
//{"callsign":"SR6XHZ","frequency":"10368.8300","locator":"JO70SS","status":"O"}

function deleteAllBeacons() {
    for (var key in beacons) {
        hideBeacons(key);
    }
    $('#bandList .bandButton').remove();
}

function hideBeaconMarker(bcn, markerProp) {
  if (bcn[markerProp]) {
    bcn[markerProp].setMap(null);
    bcn[markerProp] = null;
  }
}

function getScatterMap() {
  return typeof window.getScatterMap === 'function' ? window.getScatterMap() : null;
}

function buildBeaconInfoContent(bcn, key) {
  return '<div id="content">' +
    '<strong>Beacon</strong>' +
    '<h4 id="firstHeading" class="firstHeading">' + bcn.callsign + '</h1>' +
    '<div id="bodyContent">' +
      '<ul>' +
      '<li>Freq: ' + bcn.frequency + '</li>' +
      '<li>Locator: ' + bcn.locator + '</li>' +
      '<li>' + parseInt(bcn.distance).toLocaleString() + 'km / ' + parseInt(bcn.bearing) + '&#176;</li>' +
      '</ul>' +
      '<button onclick="spotPopup(\'' + bcn.callsign + '\',' + key + ')">Spot</button>' +
      (window._rotatorUrl ? '<button onclick="window.rotatorPointTo(\'' + bcn.callsign + '\',\'' + bcn.locator + '\')" style="margin-left:4px">⟳ Rotate</button>' : '') +
    '</div>' +
    '</div>';
}

function addBeaconMarker(bcn, key, targetMap, markerProp, openProfile) {
  if (!targetMap || bcn[markerProp]) {
    return;
  }

  var bcnLoc = bcn._mapPosition;
  var marker = new google.maps.Marker({
    position: bcnLoc,
    map: targetMap,
    title: bcn.callsign,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 10,
      fillColor: "#0000FF",
      fillOpacity: 0.7,
      strokeWeight: 0
    }
  });

  var infowindow = new google.maps.InfoWindow({
    content: buildBeaconInfoContent(bcn, key)
  });

  marker.addListener('click', function() {
    if (markerProp === 'scatterMarker' && typeof window.setScatterTarget === 'function') {
      window.setScatterTarget(bcn.locator, bcn.callsign, {
        type: 'beacon',
        frequencyMHz: bcn.frequency,
        beaconKey: key
      });
      return;
    }

    infowindow.open(targetMap, marker);
    if (openProfile) {
      showProfile({ lat: myLatLong[0], lng: myLatLong[1] }, bcnLoc);
    }
  });

  bcn[markerProp] = marker;
}

function addBeacon(bcn,key){
  var loc = gridSquareToLatLon(bcn.locator);
  var bcnLoc = {lat: loc[0], lng: loc[1]};
  bcn.distance = distVincenty(myLatLong[0],myLatLong[1],loc[0],loc[1])/1000;
  bcn.bearing = bearing(myLatLong[0],myLatLong[1],loc[0],loc[1]);
  bcn._mapPosition = bcnLoc;

  addBeaconMarker(bcn, key, map, 'marker', true);
  addBeaconMarker(bcn, key, getScatterMap(), 'scatterMarker', false);
}

function refreshScatterBeacons() {
  var scatterMap = getScatterMap();
  for (var key in beacons) {
    if (!beacons.hasOwnProperty(key)) continue;
    var list = beacons[key];
    if (beaconStates[key] === 'hide' && scatterMap) {
      for (var callsign in list) {
        if (list.hasOwnProperty(callsign)) {
          addBeacon(list[callsign], key);
        }
      }
    } else {
      for (var beaconCallsign in list) {
        if (list.hasOwnProperty(beaconCallsign)) {
          hideBeaconMarker(list[beaconCallsign], 'scatterMarker');
        }
      }
    }
  }
}

window.refreshScatterBeacons = refreshScatterBeacons;

function spotPopup(callsign, key, options) {
  if (callsign === '0') {
    return;
  }
  var popupOptions = options || {};
  spotPopupCallsign = callsign;
  spotBcn = beacons[key][callsign];
  offset = 0.0;
  $('#bcnSpotCallsign').text(spotBcn.callsign);
  $('#bcnSpotLocator').text(spotBcn.locator);
  $('#bcnSpotFreq').text(spotBcn.frequency);
  let latLng = gridSquareToLatLon(spotBcn.locator);
  let dist = distVincenty(myLatLong[0], myLatLong[1], latLng[0], latLng[1]) / 1000;
  let brg = bearing(myLatLong[0], myLatLong[1], latLng[0], latLng[1]);
  $('#bcnSpotDistBearing').text(Math.round(dist)+"km/"+Math.round(brg)+'°');
  if (popupOptions.defaultMode) {
    $('#bcnPropagationModes').val(popupOptions.defaultMode);
  }
  $('#bcnSpotModal').modal('show');
  $('#bcnReportInput').focus();
}

function spotPopupUser(callsign) {
  if (callsign === '0') {
    return;
  }
  spotPopupCallsign = callsign;
  spotUser = stationList[callsign];
  var _cachedMeta = (typeof ChatInbox !== 'undefined') ? ChatInbox.getMeta(callsign) : null;
  var _locator = spotUser ? spotUser._locator : (_cachedMeta ? _cachedMeta.locator : null);
  if (!_locator) { console.warn('spotPopupUser: no locator found for', callsign); return; }
  offset = 0.0;
  $('#userSpotCallsign').text(callsign);
  $('#userSpotLocator').text(_locator);
  $('#userSpotFrequency').text("Enter freq");
  let latLng = gridSquareToLatLon(_locator);
  let dist = distVincenty(myLatLong[0], myLatLong[1], latLng[0], latLng[1]) / 1000;
  let brg = bearing(myLatLong[0], myLatLong[1], latLng[0], latLng[1]);
  $('#userSpotDistBearing').text(Math.round(dist)+"km/"+Math.round(brg)+'°');
  $('#userSpotModal').modal('show');
  $('#userReportInput').focus();
}

function spotData(callsign,freq,locator,mode,report) {
    data = {
        spotter_callsign: userName,
        spotter_locator: myLoc,
        callsign: callsign,
        freq: freq,
        locator: locator,
        mode: mode,
        report: report,
    };
    return data;
}

  function submitSpotEntry(callsign, freqMHz, locator, mode, report) {
    var parsedFreq = parseFloat(freqMHz);
    if (isNaN(parsedFreq) || parsedFreq <= 0) {
      alert("Please enter a valid frequency in MHz");
      return false;
    }

    var spotReport = (report || '').trim();
    if (!reportPattern.test(spotReport)) {
      alert("Reports must be of the form 599, 59 or -16dB");
      return false;
    }

    const spot = spotData(callsign, parsedFreq * 1000.0, locator, mode, spotReport);
    spotToCluster(spot);
    logSpot(spot);
    return true;
  }

  window.submitSpotEntry = submitSpotEntry;

function formatFrequency(frequencyHz) {
    if (frequencyHz <= 1000000) { // 2 GHz in Hz
        return (frequencyHz / 1000).toFixed(3) + " MHz"; // Convert to MHz and format
    } else {
        return (frequencyHz / 1000000).toFixed(6) + " GHz"; // Convert to GHz and format
    }
}

function initSpotList() {
  dataTableSpots = $('#spotListTable').DataTable({
    "paging": false,
    "order": [
      [7, "desc"]
    ],
    "ordering": true,
    "info": true,
    "data": spotList,
    "columns": [{
        data: 'callsign'
      },
      {
        data: 'freq',
        type: 'num',
        render: function(data, type, row) {
          if (type == 'sort') return data;
          return formatFrequency(data);
        }
      },
      {
        data: 'spotter_callsign'
      },
      {
        data: 'distance',
        type: 'num',
        render: function(data, type, row) {
          if (type == 'sort') return data;
          return parseInt(row.distance).toLocaleString();
        }
      },
      {
        data: 'report'
      },
      {
        data: 'mode'
      },
      {
        data: 'spotter_locator'
      },
      {
        data: 'timestamp',
        type: 'num',
        render: function(data, type, row) {
          if (type == 'sort') return data;
          var d = new Date(data*1000);
          return d.toLocaleDateString() + '  ' + d.toLocaleTimeString();
        }
      }
    ],
  });

  //$('#spotListTable tbody').on('click', 'tr', function() {
    //showBeaconOnMap(dataTableUsers.row(this).data().callsign);
  //});
}


var offset=0;

$(document).ready(function(){
    modes.forEach(function(mode) {
        $('.propagationModes').append($('<option>', {
            value: mode.value,
            text: mode.text
        }));
    });

    // Set "TR" as the default selected value
    $('.propagationModes').val('TR');
    
    const increment = 0.001;
    const $freqElement = $('#bcnSpotFreq');
    const $offsetElement = $('#bcnOffset');
    
    $('#increaseFreq').on('click', function() {
        let currentFreq = parseFloat($freqElement.text());
        $freqElement.text((currentFreq + increment).toFixed(3));
        updateOffset(+1)
    });
    
    $('#decreaseFreq').on('click', function() {
        let currentFreq = parseFloat($freqElement.text());
        $freqElement.text((currentFreq - increment).toFixed(3));
        updateOffset(-1)
    });
    
    function updateOffset(inc) {
        offset = offset + inc;
        if (offset > 0) {
            $offsetElement.text('+' + (offset ).toFixed(0) + 'kHz');
        } else if (offset < 0) {
            $offsetElement.text((offset).toFixed(0) + 'kHz'); // Negative sign is already present
        } else {
            $offsetElement.text('');
        }
    }
    
    // spotToCluster(callsign,freq,locator,mode,report)
    $('#sendBcnSpot').on('click', function() {
        const currentFreq = parseFloat($freqElement.text());
        const mode = $('#bcnPropagationModes').val();
        const report = $('#bcnSpotReport').val().trim();
        if (submitSpotEntry(spotBcn.callsign, currentFreq, spotBcn.locator, mode, report)) {
          $('#bcnSpotModal').modal('hide');
        }
    }); 

    // spotToCluster(callsign,freq,locator,mode,report)
    $('#sendUserSpot').on('click', function() {
        var currentFreq = parseFloat($('#userSpotFrequency').val());
        const mode = $('#userPropagationModes').val();
        const spotcall = $('#userSpotCallsign').text();
        const spotlocator = $('#userSpotLocator').text();
        const report = $('#userSpotReport').val().trim();
        if (submitSpotEntry(spotcall, currentFreq, spotlocator, mode, report)) {
          $('#userSpotModal').modal('hide');
        }
    }); 
    
    initSpotList();
    getSpots();

});

