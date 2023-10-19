 <?php
$servername = "localhost";
$username = "<whatever>";
$password = "<whatever>";
$dbname = "<db name>";

$conn = new mysqli($servername, $username, $password, $dbname);
if ($conn->connect_error) {
  die("Connection failed: " . $conn->connect_error);
}

$sql = "SELECT * FROM beacons";
$result = $conn->query($sql);

$beacons =[];

if ($result->num_rows > 0) {
  // output data of each row
  while($row = $result->fetch_assoc()) {
     array_push($beacons,$row);
  }
}

header("Access-Control-Allow-Origin: kst2you.bss.design");
echo json_encode($beacons);
$conn->close();
?> 