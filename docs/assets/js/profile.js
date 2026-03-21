google.load("visualization", "1", { packages: ["columnchart"] });

let previousMarker = null;
let pendingPath = null;
let line;

// Called externally with two points
function showProfile(me, stnLoc) {
  pendingPath = [me, stnLoc];

  // Optionally clear previous visuals
  if (line) line.setMap(null);
  if (previousMarker) previousMarker.setMap(null);

  const chartDiv = document.getElementById("pathProfile");
  if (chartDiv) chartDiv.innerHTML = '';

  // Show the button
  const button = document.getElementById("showProfileButton");
  if (button) {
    button.style.display = 'inline-block';
  }
}

// Called when "Show Profile" is clicked
function onShowProfileClick() {
  if (!pendingPath) return;

  const button = document.getElementById("showProfileButton");
  if (button) {
    button.style.display = 'none'; // Hide the button after click
  }

  const elevator = new google.maps.ElevationService();
  displayPathElevation(pendingPath, elevator, map);
}


function setupProfileButton() {
  const button = document.createElement('button');
  button.id = 'showProfileButton';
  button.innerText = 'Show Path Profile';
  button.style.display = 'none';
  button.onclick = onShowProfileClick;
  button.style.marginTop = '10px';

  const container = document.getElementById('pathProfile');
  if (container && container.parentNode) {
    container.parentNode.insertBefore(button, container);
  }
}

// Display elevation data for a path
function displayPathElevation(path, elevator, map) {
  if (line) line.setMap(null);
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

  elevator.getElevationAlongPath({
    path: path,
    samples: 256,
  })
  .then(results => plotElevation(results, path))
  .catch(e => {
    const chartDiv = document.getElementById("pathProfile");
    chartDiv.innerHTML = "Cannot show elevation: request failed because " + e;
  });
}

// Plot the profile in the chart
function plotElevation({ results }, path) {
  const chartDiv = document.getElementById("pathProfile");
  const chart = new google.visualization.ColumnChart(chartDiv);
  const data = new google.visualization.DataTable();

  data.addColumn("string", "Sample");
  data.addColumn("number", "Elevation");

  for (let i = 0; i < results.length; i++) {
    data.addRow(["", results[i].elevation]);
  }

  const options = {
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
    titleY: "Elevation (m)",
  };

  chart.draw(data, options);

  google.visualization.events.addListener(chart, 'select', function () {
    const selection = chart.getSelection();
    const pointIndex = selection[0].row;
    const elevation = results[pointIndex].elevation;

    let lineDistance = google.maps.geometry.spherical.computeDistanceBetween(path[0], path[1]);
    const totalDistance = google.maps.geometry.spherical.computeLength(line.getPath());
    const distance = lineDistance * (pointIndex + 1) / results.length;
    const fraction = distance / totalDistance;
    const pointOnLine = google.maps.geometry.spherical.interpolate(path[0], path[1], fraction);

    if (previousMarker) {
      previousMarker.setMap(null);
    }

    previousMarker = new google.maps.Marker({
      position: pointOnLine,
      map: map,
      icon: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png'
    });

    console.log('Elevation:', elevation);
    console.log('Distance from Start:', distance);
  });
}

window.showProfile = showProfile;
window.onload = setupProfileButton;
