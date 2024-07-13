const tf = require("@tensorflow/tfjs");
const pool = require("./database");

function preprocessData(data) {
  // Extraer características y valores objetivo (incluyendo todate como característica)
  const xs = data.map((d) => [
    parseFloat(d.co2_ppm),
    parseFloat(d.co_ppb),
    parseFloat(d.r_humidity),
    parseFloat(d.pm2_5),
    parseFloat(d.pm10),
    parseFloat(d.pm1),
    parseFloat(d.pm100),
    parseFloat(d.temperature),
  ]);

  const ys = data.map((d) => parseFloat(d.usaqi));

  // Crear tensores y normalizar
  let xsTensor = tf.tensor2d(xs);
  let ysTensor = tf.tensor2d(ys, [ys.length, 1]);

  const xsMin = xsTensor.min(0);
  const xsMax = xsTensor.max(0);
  xsTensor = xsTensor.sub(xsMin).div(xsMax.sub(xsMin));

  return [xsTensor, ysTensor, xsMin, xsMax];
}

function createModel() {
  const model = tf.sequential();
  model.add(
    tf.layers.dense({ inputShape: [8], units: 20, activation: "relu" })
  ); // 8 características de entrada
  model.add(tf.layers.dense({ units: 10, activation: "relu" }));
  model.add(tf.layers.dense({ units: 1 }));
  model.compile({ optimizer: "adam", loss: "meanSquaredError" });
  return model;
}

async function trainModel(model, xs, ys) {
  await model.fit(xs, ys, {
    epochs: 10000,
    validationSplit: 0.2,
    callbacks: tf.callbacks.earlyStopping({ patience: 10 }),
  });
}

async function getLastRecord() {
  try {
    const lastRecord = await pool.query(
      "SELECT MAX(todate) as last_todate FROM mayo_predi"
    ); // Obtener el valor máximo de todate
    return lastRecord;
  } catch (err) {
    console.error("Error al obtener el último registro:", err);
    return null;
  }
}
async function main() {
  // Obtener datos de la API
  const response = await fetch("https://web-servirce-machine.vercel.app/todo");
  const data = await response.json();

  // Declaración de featureNames fuera del bloque then
  const featureNames = [
    "co2_ppm",
    "co_ppb",
    "r_humidity",
    "pm2_5",
    "pm10",
    "pm1",
    "pm100",
    "temperature",
  ];

  // Filtrar datos no válidos (ajustado a la nueva estructura)
  const filteredData = data.filter((sample) => {
    for (const feature of featureNames) {
      if (feature === "todate") {
        // Validar si todate es una fecha válida
        if (isNaN(Date.parse(sample[feature]))) {
          console.warn(`Muestra no válida (todate): ${JSON.stringify(sample)}`);
          return false;
        }
      } else {
        const value = parseFloat(sample[feature]); // Convertir a número
        if (isNaN(value) || !isFinite(value)) {
          console.warn(`Muestra no válida: ${JSON.stringify(sample)}`);
          return false;
        }
      }
    }
    return true;
  });

  console.log("Datos filtrados:", filteredData);
  console.log("Número de muestras válidas:", filteredData.length);

  const [xs, ys, xsMin, xsMax] = preprocessData(filteredData);

  const numTrainingSamples = Math.floor(0.8 * filteredData.length);
  const xsTrain = xs.slice([0, 0], [numTrainingSamples, 8]); // 8 características
  const ysTrain = ys.slice([0, 0], [numTrainingSamples, 1]);
  const xsTest = xs.slice(
    [numTrainingSamples, 0],
    [filteredData.length - numTrainingSamples, 8] // 8 características
  );
  const ysTest = ys.slice(
    [numTrainingSamples, 0],
    [filteredData.length - numTrainingSamples, 1]
  );

  const model = createModel();
  await trainModel(model, xsTrain, ysTrain);

  const evaluation = model.evaluate(xsTest, ysTest);
  if (evaluation && evaluation.length === 2) {
    console.log("Evaluation Results:");
    console.log("  Loss (MSE):", evaluation[0].dataSync());
  } else {
    console.error("Evaluation failed. Check your model and data.");
  }

  const predictions = model.predict(xsTest);
  const inputValues = await xsTest.data();
  const predictionValues = await predictions.data();

  // Obtener la última fecha y hora registradas en la base de datos
  const lastRecord = await getLastRecord();
  let currentDate = new Date("2024-05-01"); // Fecha de inicio predeterminada
  let currentHour = 0; // Hora de inicio predeterminada

  if (
    lastRecord &&
    lastRecord.rows.length > 0 &&
    lastRecord.rows[0].last_todate
  ) {
    // Verificar si hay registros
    currentDate = new Date(lastRecord.rows[0].last_todate);
    currentHour = currentDate.getHours();
  }

  const predictionsToGenerate = 168; // Predicciones para una semana (7 días * 24 horas)
  let predictionsGenerated = 0;
  let inputFeatures; // Declaramos inputFeatures fuera del bucle

  // Insertar predicciones en la base de datos PostgreSQL (de forma asíncrona)
  while (
    predictionsGenerated < predictionsToGenerate &&
    currentDate.getDay() !== 0
  ) {
    inputFeatures = inputValues.slice(
      predictionsGenerated * 8,
      predictionsGenerated * 8 + 8
    ); // <-- Actualizamos inputFeatures en cada iteración
    const usaqi = predictionValues[predictionsGenerated].toFixed(2);

    try {
      if (!isNaN(usaqi) && usaqi > 0) {
        // Formatear la fecha y hora
        const formattedToDate = new Date(currentDate);
        formattedToDate.setHours(currentHour, 0, 0, 0); // Ajustar la hora al valor actual

        // Desnormalizar las características de entrada
        const denormalizedFeatures = inputFeatures.map(
          (feature, index) =>
            feature * (xsMax.dataSync()[index] - xsMin.dataSync()[index]) +
            xsMin.dataSync()[index]
        );

        // Espera a que la consulta se complete antes de continuar
        const res = await pool.query(
          "INSERT INTO mayo_predi (usaqi, co2_ppm, co_ppb, r_humidity, pm2_5, pm10, pm1, pm100, temperature, todate) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *",
          [usaqi, ...denormalizedFeatures, formattedToDate]
        );

        if (res.rowCount === 1) {
          console.log("Predicción insertada:", res.rows[0]);
        } else {
          console.warn("La inserción no se realizó correctamente");
        }

        // Calcular outputLine dentro del bucle for
        const outputLine = featureNames.reduce((acc, name, index) => {
          return acc + `${name}: ${denormalizedFeatures[index].toFixed(2)} | `;
        }, "");
        console.log(
          `usaqi: ${predictionValues[predictionsGenerated].toFixed(
            2
          )} | ${outputLine}todate: ${formattedToDate.toISOString()} |`
        );
      } else {
        console.warn("Predicción no válida:", usaqi);
      }
    } catch (err) {
      console.error("Error al insertar predicción:", err);
    }

    // Incrementar la hora y el día si es necesario
    currentHour++;
    if (currentHour === 24) {
      currentHour = 0;
      currentDate.setDate(currentDate.getDate() + 1);
    }
    predictionsGenerated++;
  } // Fin del bucle while

  // Cerrar el pool de conexiones después de insertar todas las predicciones
  await pool.end();
}

main();
