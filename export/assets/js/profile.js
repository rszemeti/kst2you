/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
// Load the Visualization API and the columnchart package.
// @ts-ignore TODO update to newest visualization library
google.load("visualization", "1", { packages: ["columnchart"] });

let previousMarker = null;

function showProfile(me,stnLoc) {
  // The following path marks a path from Mt. Whitney, the highest point in the
  // continental United States to Badwater, Death Valley, the lowest point.
  const path = [
    me,
    stnLoc
  ]; 

  // Create an ElevationService.
  const elevator = new google.maps.ElevationService();

  // Draw the path, using the Visualization API and the Elevation service.
  displayPathElevation(path, elevator, map);
}

var line;

function displayPathElevation(path, elevator, map) {
  // Display a polyline of the elevation path.
  if (typeof line !== 'undefined') {
    line.setMap(null);
  }  
    
 if (previousMarker) {
    previousMarker.setMap(null);
    previousMarker = null;
  }  
    
  line = new google.maps.Polyline({
      path: path,
      geodesic: true,
      strokeColor: "#FF0000",
      strokeOpacity: 1.0,
      strokeWeight: 2,
      map: map
  });
  // Create a PathElevationRequest object using this array.
  // Ask for 256 samples along that path.
  // Initiate the path request.
  elevator
    .getElevationAlongPath({
      path: path,
      samples: 256,
    })
    .then(results => plotElevation(results, path))
    .catch((e) => {
      const chartDiv = document.getElementById("pathProfile");

      // Show the error code inside the chartDiv.
      chartDiv.innerHTML = "Cannot show elevation: request failed because " + e;
    });
}

// Takes an array of ElevationResult objects, draws the path on the map
// and plots the elevation profile on a Visualization API ColumnChart.
function plotElevation({results}, path) {
  const chartDiv = document.getElementById("pathProfile");
  // Create a new chart in the elevation_chart DIV.
  const chart = new google.visualization.ColumnChart(chartDiv);
  // Extract the data from which to populate the chart.
  // Because the samples are equidistant, the 'Sample'
  // column here does double duty as distance along the
  // X axis.
  const data = new google.visualization.DataTable();

  data.addColumn("string", "Sample");
  data.addColumn("number", "Elevation");

  for (let i = 0; i < results.length; i++) {
    data.addRow(["", results[i].elevation]);
  }

    
  var options = {
    chartArea: {
      left: 40,
      width: '100%'
    },
    legend: {
      position: 'top'
    },
    width: '100%',
    height: 150,
    legend: "none",
    // @ts-ignore TODO update to newest visualization library
    titleY: "Elevation (m)",
  }  
  // Draw the chart using the data within its DIV.
  chart.draw(data, options);


google.visualization.events.addListener(chart, 'select', function() {
    const selection = chart.getSelection();
    const pointIndex = selection[0].row;
    const elevation = results[pointIndex].elevation;

    // Calculate the total distance of the path
    let lineDistance = google.maps.geometry.spherical.computeDistanceBetween(path[0], path[1]);
    const totalDistance = google.maps.geometry.spherical.computeLength(line.getPath());

    // Calculate the distance from the start to the selected point
    const distance = lineDistance * (pointIndex + 1) / results.length;

    // Find the point on the line based on the calculated distance
    const fraction = distance / totalDistance;
    const pointOnLine = google.maps.geometry.spherical.interpolate(path[0], path[1], fraction);

    // Remove the previous marker, if any
    if (previousMarker) {
        previousMarker.setMap(null);
    }

    // Add a marker at the point on the line
    const marker = new google.maps.Marker({
        position: pointOnLine,
        map: map,
        icon: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png'
    });

    // Set the new marker as the previous marker
    previousMarker = marker;

    console.log('Elevation:', elevation);
    console.log('Distance from Start:', distance);
});


}



window.showProfile = showProfile;
