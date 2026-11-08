// Address -> lat/lon for the site view. Runs server-side so the geocoding key stays private.
// Uses Google Geocoding when GOOGLE_GEOCODING_KEY (or NEXT_PUBLIC_GOOGLE_MAPS_KEY) is set,
// otherwise OpenStreetMap Nominatim (free, ~1 request/second, fine for a demo).
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q) return Response.json({ error: "Missing ?q=address" }, { status: 400 });

  const key = process.env.GOOGLE_GEOCODING_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  try {
    if (key) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${key}`;
      const data = await (await fetch(url)).json();
      const top = data.results?.[0];
      if (top) {
        return Response.json({ lat: top.geometry.location.lat, lon: top.geometry.location.lng, label: top.formatted_address });
      }
      if (data.status && data.status !== "ZERO_RESULTS") {
        // Key not enabled for Geocoding etc. Fall through to Nominatim instead of failing the demo.
        console.warn("Google geocoding:", data.status, data.error_message ?? "");
      } else {
        return Response.json({ error: `No match for "${q}"` }, { status: 404 });
      }
    }
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "User-Agent": "Walkthru-hackathon-demo/0.1" } });
    const top = (await res.json())?.[0];
    if (!top) return Response.json({ error: `No match for "${q}"` }, { status: 404 });
    return Response.json({ lat: Number(top.lat), lon: Number(top.lon), label: top.display_name });
  } catch (e) {
    return Response.json({ error: `Geocoding failed: ${String(e)}` }, { status: 502 });
  }
}
