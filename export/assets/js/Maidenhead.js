// HamGridSquare.js
// Copyright 2014 Paul Brewer KI6CQ
// License:  MIT License http://opensource.org/licenses/MIT
//
// Javascript routines to convert from lat-lon to Maidenhead Grid Squares
// typically used in Ham Radio Satellite operations and VHF Contests
//
// Inspired in part by K6WRU Walter Underwood's python answer
// http://ham.stackexchange.com/a/244
// to this stack overflow question:
// How Can One Convert From Lat/Long to Grid Square
// http://ham.stackexchange.com/questions/221/how-can-one-convert-from-lat-long-to-grid-square
//

//
// Modified for all uppercase ouput as per 
// https://www.iaru-r1.org/wp-content/uploads/2021/03/VHF_Handbook_V9.01.pdf p120
//

latLonToGridSquare = function(param1,param2){
  var lat=-100.0;
  var lon=0.0;
  var adjLat,adjLon,GLat,GLon,nLat,nLon,gLat,gLon,rLat,rLon;
  var U = 'ABCDEFGHIJKLMNOPQRSTUVWX'
  // support Chris Veness 2002-2012 LatLon library and
  // other objects with lat/lon properties
  // properties could be numbers, or strings
  function toNum(x){
    if (typeof(x) === 'number') return x;
    if (typeof(x) === 'string') return parseFloat(x);
    // dont call a function property here because of binding issue
    throw "HamGridSquare -- toNum -- can not convert input: "+x;
  }
  if (typeof(param1)==='object'){
    if (param1.length === 2){
      lat = toNum(param1[0]);
      lon = toNum(param1[1]);
    } else if (('lat' in param1) && ('lon' in param1)){
      lat = (typeof(param1.lat)==='function')? toNum(param1.lat()): toNum(param1.lat);
      lon = (typeof(param1.lon)==='function')? toNum(param1.lon()): toNum(param1.lon);
    } else if (('latitude' in param1) && ('longitude' in param1)){
      lat = (typeof(param1.latitude)==='function')? toNum(param1.latitude()): toNum(param1.latitude);
      lon = (typeof(param1.longitude)==='function')? toNum(param1.longitude()): toNum(param1.longitude);
    } else {
      throw "HamGridSquare -- can not convert object -- "+param1;
    }
  } else {
    lat = toNum(param1);
    lon = toNum(param2);
  }
  if (isNaN(lat)) throw "lat is NaN";
  if (isNaN(lon)) throw "lon is NaN";
  if (Math.abs(lat) === 90.0) throw "grid squares invalid at N/S poles";
  if (Math.abs(lat) > 90) throw "invalid latitude: "+lat;
  if (Math.abs(lon) > 180) throw "invalid longitude: "+lon;
  adjLat = lat + 90;
  adjLon = lon + 180;
  GLat = U[Math.trunc(adjLat/10)];
  GLon = U[Math.trunc(adjLon/20)];
  nLat = ''+Math.trunc(adjLat % 10);
  nLon = ''+Math.trunc((adjLon/2) % 10);
  rLat = (adjLat - Math.trunc(adjLat)) * 60;
  rLon = (adjLon - 2*Math.trunc(adjLon/2)) *60;
  gLat = U[Math.trunc(rLat/2.5)];
  gLon = U[Math.trunc(rLon/5)];
  return GLon+GLat+nLon+nLat+gLon+gLat;
}

gridSquareToLatLon = function(grid){
		grid = grid.toUpperCase();
		gridLen = grid.length;
		if (gridLen < 4)  grid += '55LL55LL';
		if (gridLen < 6)  grid += 'LL55LL';
		if (gridLen < 8)  grid += '55LL';
		if (gridLen < 10) grid += 'LL';
		var gridFormat = /[A-R]{2}[0-9]{2}[A-X]{2}[0-9]{2}[A-X]{2}/;
		if (gridFormat.test(grid) && (gridLen % 2 == 0)) {
            return fromLocator(grid);
		} else {
            throw("Invalid locator format");
		}
	}     

function fromLocator(loc){
    var i = 0;
    var l = new Array();
    loc = loc.toUpperCase();
    while (i < 10) l[i] = loc.charCodeAt(i++) - 65;
    l[2] += 17; l[3] += 17;
    l[6] += 17; l[7] += 17;
    var lon = (l[0]*20 + l[2]*2 + l[4]/12 + l[6]/120 + l[8]/2880 - 180);
    var lat = (l[1]*10 + l[3] + l[5]/24 + l[7]/240 + l[9]/5760 - 90);

    return [lat,lon];
};

testGridSquare = function(){
  // First four test examples are from "Conversion Between Geodetic and Grid Locator Systems",
  // by Edmund T. Tyson N5JTY QST January 1989
  // original test data in Python / citations by Walter Underwood K6WRU
  // last test and coding into Javascript from Python by Paul Brewer KI6CQ
  var testData = [
    ['Munich', [48.14666,11.60833], 'JN58TD'],
    ['Montevideo', [[-34.91,-56.21166]], 'GF15VC'],
    ['Washington, DC', [{lat:38.92,lon:-77.065}], 'FM18LW'],
    ['Wellington', [{latitude:-41.28333,longitude:174.745}], 'RE78IR'],
    ['Newington, CT (W1AW)', [41.714775,-72.727260], 'FN31PR'],
    ['Palo Alto (K6WRU)', [[37.413708,-122.1073236]], 'CM87WJ'],
    ['Chattanooga (KI6CQ/4)', [{lat:function(){ return "35.0542"; }, 
                              lon: function(){ return "-85.1142"}}], "EM75KB"]
  ];
  var i=0,l=testData.length,result='',result2,result3,thisPassed=0,totalPassed=0;
  for(i=0;i<l;++i){
    result = latLonToGridSquare.apply({}, testData[i][1]);
    result2 = gridSquareToLatLon(result);
    result3 = latLonToGridSquare(result2);
    thisPassed = (result===testData[i][2]) && (result3===testData[i][2]);
    console.log("test "+i+": "+testData[i][0]+" "+JSON.stringify(testData[i][1])+
                " result = "+result+" result2 = "+result2+" result3 = "+result3+" expected= "+testData[i][2]+
                " passed = "+thisPassed);
    totalPassed += thisPassed;
  }
  console.log(totalPassed+" of "+l+" test passed");
  return totalPassed===l;
};

HamGridSquare = {
  toLatLon: gridSquareToLatLon,
  fromLatLon: latLonToGridSquare,
  test: testGridSquare
};

/*!
 * JavaScript function to calculate the geodetic distance between two points specified by latitude/longitude using the Vincenty inverse formula for ellipsoids.
 *
 * Original scripts by Chris Veness
 * Taken from http://movable-type.co.uk/scripts/latlong-vincenty.html and optimized / cleaned up by Mathias Bynens <http://mathiasbynens.be/>
 * Based on the Vincenty direct formula by T. Vincenty, “Direct and Inverse Solutions of Geodesics on the Ellipsoid with application of nested equations”, Survey Review, vol XXII no 176, 1975 <http://www.ngs.noaa.gov/PUBS_LIB/inverse.pdf>
 *
 * @param   {Number} lat1, lon1: first point in decimal degrees
 * @param   {Number} lat2, lon2: second point in decimal degrees
 * @returns {Number} distance in metres between points
 */
function toRad(n) {
 return n * Math.PI / 180;
};

function distVincenty(lat1, lon1, lat2, lon2) {
 var a = 6378137,
     b = 6356752.3142,
     f = 1 / 298.257223563, // WGS-84 ellipsoid params
     L = toRad(lon2-lon1),
     U1 = Math.atan((1 - f) * Math.tan(toRad(lat1))),
     U2 = Math.atan((1 - f) * Math.tan(toRad(lat2))),
     sinU1 = Math.sin(U1),
     cosU1 = Math.cos(U1),
     sinU2 = Math.sin(U2),
     cosU2 = Math.cos(U2),
     lambda = L,
     lambdaP,
     iterLimit = 100;
 do {
  var sinLambda = Math.sin(lambda),
      cosLambda = Math.cos(lambda),
      sinSigma = Math.sqrt((cosU2 * sinLambda) * (cosU2 * sinLambda) + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda));
  if (0 === sinSigma) {
   return 0; // co-incident points
  };
  var cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda,
      sigma = Math.atan2(sinSigma, cosSigma),
      sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma,
      cosSqAlpha = 1 - sinAlpha * sinAlpha,
      cos2SigmaM = cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha,
      C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
  if (isNaN(cos2SigmaM)) {
   cos2SigmaM = 0; // equatorial line: cosSqAlpha = 0 (§6)
  };
  lambdaP = lambda;
  lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
 } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);

 if (!iterLimit) {
  return NaN; // formula failed to converge
 };

 var uSq = cosSqAlpha * (a * a - b * b) / (b * b),
     A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq))),
     B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq))),
     deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) - B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM))),
     s = b * A * (sigma - deltaSigma);
 return s.toFixed(3); // round to 1mm precision
};

// Converts from degrees to radians.
function toRadians(degrees) {
  return degrees * Math.PI / 180;
};
 
// Converts from radians to degrees.
function toDegrees(radians) {
  return radians * 180 / Math.PI;
}


function bearing(startLat, startLng, destLat, destLng){
  startLat = toRadians(startLat);
  startLng = toRadians(startLng);
  destLat = toRadians(destLat);
  destLng = toRadians(destLng);

  y = Math.sin(destLng - startLng) * Math.cos(destLat);
  x = Math.cos(startLat) * Math.sin(destLat) -
        Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
  brng = Math.atan2(y, x);
  brng = toDegrees(brng);
  return (brng + 360) % 360;
}

