var beacons = {}; // Use an object instead of an array
var beaconStates={};

function fetchBeacons(min,max) {
   beacons={};
   $.getJSON('https://storage.googleapis.com/kst2you/BeaconList.json', function (data) {
        data.forEach(function (item) {
            let frequencyKey = parseInt(item.frequency);
            if((frequencyKey >= min) && (frequencyKey <= max)){
                if (!beacons[frequencyKey]) {
                    beacons[frequencyKey] = [];
                }
                beacons[frequencyKey].push(item);
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
        console.log(beacons);
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
        console.log(beacons[key][i]);
        addBeacon(beacons[key][i]);
    }    
}

function hideBeacons(key) {
    var list = beacons[key];
    for (var i in list) {
        if (beacons[key][i].marker) {
            beacons[key][i].marker.setMap(null);
        }
        beacons[key][i].marker = null;
    }
}
//{"callsign":"SR6XHZ","frequency":"10368.8300","locator":"JO70SS","status":"O"}

function addBeacon(bcn){
  loc = gridSquareToLatLon(bcn.locator);
  var bcnLoc = {lat: loc[0], lng: loc[1]};
  bcn.distance = distVincenty(myLatLong[0],myLatLong[1],loc[0],loc[1])/1000;
  bcn.bearing = bearing(myLatLong[0],myLatLong[1],loc[0],loc[1]);
  var marker = new google.maps.Marker({
      position: bcnLoc,
      map: map, 
      title: bcn.callsign,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,  // Adjust for the size you want
        fillColor: "#0000FF",
        fillOpacity: 0.7,
        strokeWeight: 0
      }
    });
      var contentString = '<div id="content">'+
      '<strong>Beacon</strong>'+
      '<h4 id="firstHeading" class="firstHeading">'+bcn.callsign+'</h1>'+
      '<div id="bodyContent">'+
          '<ul>'+
          '<li>Freq: '+bcn.frequency+'</li>'+
          '<li>Locator: '+bcn.locator+'</li>'+
          '<li>'+parseInt(bcn.distance).toLocaleString()+'km / '+parseInt(bcn.bearing)+'&#176;</li>'+
          '</ul>'+
      '</div>'+
      '</div>';

   var infowindow = new google.maps.InfoWindow({
     content: contentString
   });
    marker.addListener('click', function() {
     infowindow.open(map, marker);
     showProfile( {lat: myLatLong[0], lng: myLatLong[1]},bcnLoc);
   });

   bcn.marker = marker;
}