'use strict';

const express = require('express');
const superagent = require('superagent');
const cors = require('cors');
const app = express();
const pg = require('pg');

app.use(cors());
require('dotenv').config();
const PORT = process.env.PORT || 3000;

const client = new pg.Client(process.env.DATABASE_URL);
client.connect();

app.use(express.static('./'));

app.get('/', (request, response) => {
  response.status(200).send('Connected!');
});

app.get('/location', queryLocation);

app.get('/weather', weatherApp);

app.get('/events', eventsApp);

//uses google API to fetch coordinate data to send to front end using superagent
//has a catch method to handle bad user search inputs in case google maps cannot
//find location
function locationApp(request, response) {
  const googleMapsUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${request.query.data}&key=${process.env.GEOCODE_API_KEY}`;
  return superagent.get(googleMapsUrl)
    .then(result => {
      const location = new Location(request, result);
      let insertSQL = 'INSERT INTO locations ( search_query, formatted_query, latitude, longitude, created_at ) VALUES ( $1, $2, $3, $4, $5);';
      let insertParams = [location.search_query, location.formatted_query, location.latitude, location.longitude, location.created_at];
      client.query(insertSQL, insertParams);
      queryLocation(request, response);
    })
    .catch(error => handleError(error, response));
}

//This section is for querying database
function queryLocation(request, response) {
  const sql = 'SELECT * FROM locations WHERE search_query = $1;';
  const params = [request.query.data];
  return client.query(sql, params)
    .then(result => {
      if (result.rowCount > 0) {
        response.send(result.rows[0]);
      } else {
        locationApp(request, response);
      }
    })
    .catch(error => handleError(error, response));
}

function queryTable(table, request, response) {
  const sql = `SELECT * FROM ${table.name} WHERE location_id = $1`;
  const values = [request.query.data.id];
  return client.query(sql, values)
    .then(result => {
      if (result.rowCount > 0) {
        table.cacheHit(result.rows);
      } else {
        table.cacheMiss(request, response);
      }
    })
    .catch(error => handleError(error, response));
}
// ------------------------------------------

// This section is handling GET routes
function weatherApp(req, res) {
  const weather = new Options('weathers', req, res);
  weather.cacheMiss = getWeatherAPI;
  queryTable(weather, req, res);
}

function eventsApp(req, res) {
  const events = new Options('events', req, res);
  events.cacheMiss = getEventsAPI;
  queryTable(events, req, res);
}

// This section is for API retrieval
function getWeatherAPI(req, res) {
  const darkSkyUrl = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${req.query.data.latitude},${req.query.data.longitude}`;
  return superagent.get(darkSkyUrl)
    .then(result => {
      //make map one liner
      const weatherSummaries = result.body.daily.data.map(data => {
        const day = new Weather(data, req.query.data.search_query);
        const SQL = `INSERT INTO weathers (forecast, time, location_id, created_at) VALUES ($1, $2, $3, $4);`;
        const values = [data.summary, day.time, req.query.data.id, day.created_at];
        client.query(SQL, values);
        return day;
      });
      res.send(weatherSummaries);
    })
    .catch(error => handleError(error, res));
}

function getEventsAPI(req, res) {
  const eventBriteUrl = `https://www.eventbriteapi.com/v3/events/search/?location.within=10mi&location.latitude=${req.query.data.latitude}&location.longitude=${req.query.data.longitude}&token=${process.env.EVENTBRITE_API_KEY}`;
  return superagent.get(eventBriteUrl)
    .then(result => {
      const eventSummaries = result.body.events.map(event => {
        const eventItem = new Event(event, req.query.data.search_query);
        const SQL = `INSERT INTO events (link, name, event_date, summary, location_id, created_at) VALUES ($1, $2, $3, $4, $5, $6);`;
        const values = [event.url, event.name.text, event.start.local, event.description.text, req.query.data.id, eventItem.created_at];
        client.query(SQL, values);
        return eventItem;
      });
      res.send(eventSummaries);
    })
    .catch(error => handleError(error, res));
}

function handleError(err, res) {
  if (err) res.status(500).send('Internal 500 error!');
}


// This section is for constructors
function Weather(day) {
  this.time = new Date(day.time * 1000).toDateString();
  this.forecast = day.summary;
  this.created_at = Date.now();
}

//Refactored to pass more concise arguments
function Location(request, result) {
  this.search_query = request.query.data;
  this.formatted_query = result.body.results[0].formatted_address;
  this.latitude = result.body.results[0].geometry.location.lat;
  this.longitude = result.body.results[0].geometry.location.lng;
  this.created_at = Date.now();
}

function Event(data) {
  this.link = data.url;
  this.name = data.name.text;
  this.event_date = new Date(data.start.local).toDateString();
  this.summary = data.description.text;
  this.created_at = Date.now();
}

function Options(tableName, request, response) {
  this.name = tableName;
  this.cacheMiss;
  this.cacheHit = (results) => {
    const timeInSeconds = (Date.now() - results[0].created_at) / (1000);
    if (timeInSeconds > 15) {
      console.log('hammer time', this.name);
      deleteTableContents(this.name, request.query.data.id);
      this.cacheMiss(request, response);
    } else {
      response.send(results);
    }
  };
}

function deleteTableContents(table, city) {
  const SQL = `DELETE from ${table} WHERE location_id=${city};`;
  return client.query(SQL);
}

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
