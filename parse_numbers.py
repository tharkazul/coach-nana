import sys
import json
from numbers_parser import Document

def main():
    doc = Document('garmin_exercises.numbers')
    sheets = doc.sheets
    tables = sheets[0].tables
    table = tables[0]

    data = []
    rows = table.rows()
    
    # Assuming first row is header: category_key, exercize_key, exercize_name
    header = [cell.value for cell in rows[0]]
    
    for row_idx in range(1, len(rows)):
        row_values = [cell.value for cell in rows[row_idx]]
        
        # Skip empty rows
        if not any(row_values):
            continue
            
        row_dict = {}
        for i, val in enumerate(row_values):
            if i < len(header):
                key = header[i]
                if key:
                    row_dict[key] = val
        data.append(row_dict)

    with open('garmin_exercises.json', 'w') as f:
        json.dump(data, f, indent=2)

if __name__ == '__main__':
    main()
