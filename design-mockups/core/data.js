// Mock data for UI mockups. Copied from shared/sample_layout.json + backend/cached program.
export const LAYOUT = {
  "footprint": {
    "width_ft": 49.5,
    "depth_ft": 35.5
  },
  "entrance": {
    "x": 37.0,
    "y": 35.5
  },
  "rooms": [
    {
      "id": "primary_bedroom",
      "type": "primary_bedroom",
      "name": "Primary Bedroom",
      "target_sqft": 250.0,
      "adjacent_to": [
        "bathroom_1"
      ],
      "x": 0.0,
      "y": 0.0,
      "w": 16.5,
      "h": 15.0
    },
    {
      "id": "bathroom_1",
      "type": "bathroom",
      "name": "Primary Bath",
      "target_sqft": 70.0,
      "adjacent_to": [
        "primary_bedroom"
      ],
      "x": 16.5,
      "y": 0.0,
      "w": 5.0,
      "h": 15.0
    },
    {
      "id": "bedroom_2",
      "type": "bedroom",
      "name": "Bedroom 2",
      "target_sqft": 130.0,
      "adjacent_to": [],
      "x": 21.5,
      "y": 0.0,
      "w": 8.5,
      "h": 15.0
    },
    {
      "id": "bathroom_2",
      "type": "bathroom",
      "name": "Bath 2",
      "target_sqft": 55.0,
      "adjacent_to": [],
      "x": 30.0,
      "y": 0.0,
      "w": 4.0,
      "h": 15.0
    },
    {
      "id": "bedroom_3",
      "type": "bedroom",
      "name": "Bedroom 3",
      "target_sqft": 125.0,
      "adjacent_to": [],
      "x": 34.0,
      "y": 0.0,
      "w": 8.0,
      "h": 15.0
    },
    {
      "id": "office",
      "type": "office",
      "name": "Office",
      "target_sqft": 110.0,
      "adjacent_to": [],
      "x": 42.0,
      "y": 0.0,
      "w": 7.5,
      "h": 15.0
    },
    {
      "id": "hall",
      "type": "hall",
      "name": "Hall",
      "target_sqft": 198.0,
      "adjacent_to": [],
      "x": 0.0,
      "y": 15.0,
      "w": 49.5,
      "h": 4.0
    },
    {
      "id": "laundry",
      "type": "laundry",
      "name": "Laundry",
      "target_sqft": 45.0,
      "adjacent_to": [],
      "x": 0.0,
      "y": 19.0,
      "w": 2.5,
      "h": 16.5
    },
    {
      "id": "kitchen",
      "type": "kitchen",
      "name": "Kitchen",
      "target_sqft": 210.0,
      "adjacent_to": [
        "dining"
      ],
      "x": 2.5,
      "y": 19.0,
      "w": 13.0,
      "h": 16.5
    },
    {
      "id": "dining",
      "type": "dining",
      "name": "Dining",
      "target_sqft": 150.0,
      "adjacent_to": [
        "kitchen",
        "living"
      ],
      "x": 15.5,
      "y": 19.0,
      "w": 9.0,
      "h": 16.5
    },
    {
      "id": "living",
      "type": "living",
      "name": "Living Room",
      "target_sqft": 420.0,
      "adjacent_to": [
        "dining"
      ],
      "x": 24.5,
      "y": 19.0,
      "w": 25.0,
      "h": 16.5
    }
  ],
  "doors": [
    {
      "between": [
        "primary_bedroom",
        "hall"
      ],
      "x": 8.0,
      "y": 15.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "bathroom_1",
        "hall"
      ],
      "x": 19.0,
      "y": 15.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "bedroom_2",
        "hall"
      ],
      "x": 26.0,
      "y": 15.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "bathroom_2",
        "hall"
      ],
      "x": 32.0,
      "y": 15.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "bedroom_3",
        "hall"
      ],
      "x": 38.0,
      "y": 15.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "office",
        "hall"
      ],
      "x": 46.0,
      "y": 15.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "laundry",
        "hall"
      ],
      "x": 1.0,
      "y": 19.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "kitchen",
        "hall"
      ],
      "x": 9.0,
      "y": 19.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "dining",
        "hall"
      ],
      "x": 20.0,
      "y": 19.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "living",
        "hall"
      ],
      "x": 37.0,
      "y": 19.0,
      "width_ft": 3.0
    },
    {
      "between": [
        "exterior",
        "living"
      ],
      "x": 37.0,
      "y": 35.5,
      "width_ft": 3.0
    }
  ],
  "windows": [
    {
      "room": "primary_bedroom",
      "wall": "north",
      "offset_ft": 6.0,
      "width_ft": 4.0
    },
    {
      "room": "bathroom_1",
      "wall": "north",
      "offset_ft": 1.0,
      "width_ft": 3.0
    },
    {
      "room": "bedroom_2",
      "wall": "north",
      "offset_ft": 2.0,
      "width_ft": 4.0
    },
    {
      "room": "bathroom_2",
      "wall": "north",
      "offset_ft": 1.0,
      "width_ft": 2.0
    },
    {
      "room": "bedroom_3",
      "wall": "north",
      "offset_ft": 2.0,
      "width_ft": 4.0
    },
    {
      "room": "office",
      "wall": "north",
      "offset_ft": 2.0,
      "width_ft": 4.0
    },
    {
      "room": "kitchen",
      "wall": "south",
      "offset_ft": 4.5,
      "width_ft": 4.0
    },
    {
      "room": "dining",
      "wall": "south",
      "offset_ft": 2.5,
      "width_ft": 4.0
    }
  ],
  "checks": [
    {
      "rule": "no_overlap_in_footprint",
      "pass": true,
      "message": ""
    },
    {
      "rule": "all_rooms_reachable",
      "pass": true,
      "message": ""
    },
    {
      "rule": "bedroom_exterior_wall",
      "pass": true,
      "message": ""
    },
    {
      "rule": "public_bathroom",
      "pass": true,
      "message": ""
    },
    {
      "rule": "kitchen_adjacent",
      "pass": true,
      "message": ""
    },
    {
      "rule": "min_hall_and_door_width",
      "pass": true,
      "message": ""
    },
    {
      "rule": "sizes_within_10pct",
      "pass": true,
      "message": ""
    }
  ],
  "requested_sqft": 1800.0
};
export const PROGRAM = {
 "requested_sqft": 1800.0,
 "aspect_ratio": 1.4,
 "rooms": [
  {
   "id": "primary_bedroom",
   "type": "primary_bedroom",
   "name": "Primary Bedroom",
   "target_sqft": 250.0,
   "adjacent_to": [
    "bathroom_1"
   ]
  },
  {
   "id": "bathroom_1",
   "type": "bathroom",
   "name": "Primary Bath",
   "target_sqft": 70.0,
   "adjacent_to": [
    "primary_bedroom"
   ]
  },
  {
   "id": "bedroom_2",
   "type": "bedroom",
   "name": "Bedroom 2",
   "target_sqft": 130.0,
   "adjacent_to": []
  },
  {
   "id": "bathroom_2",
   "type": "bathroom",
   "name": "Bath 2",
   "target_sqft": 55.0,
   "adjacent_to": []
  },
  {
   "id": "bedroom_3",
   "type": "bedroom",
   "name": "Bedroom 3",
   "target_sqft": 125.0,
   "adjacent_to": []
  },
  {
   "id": "office",
   "type": "office",
   "name": "Office",
   "target_sqft": 110.0,
   "adjacent_to": []
  },
  {
   "id": "kitchen",
   "type": "kitchen",
   "name": "Kitchen",
   "target_sqft": 210.0,
   "adjacent_to": [
    "dining"
   ]
  },
  {
   "id": "dining",
   "type": "dining",
   "name": "Dining",
   "target_sqft": 150.0,
   "adjacent_to": [
    "kitchen",
    "living"
   ]
  },
  {
   "id": "living",
   "type": "living",
   "name": "Living Room",
   "target_sqft": 420.0,
   "adjacent_to": [
    "dining"
   ]
  },
  {
   "id": "laundry",
   "type": "laundry",
   "name": "Laundry",
   "target_sqft": 45.0,
   "adjacent_to": []
  }
 ],
 "notes": "3 bed, 2 bath, open kitchen, home office"
};
