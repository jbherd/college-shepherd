module.exports = async function handler(req, res) {
  console.log("FUNCTION HIT");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  return res.status(200).json({ message: "API is working", time: new Date().toISOString() });
};
