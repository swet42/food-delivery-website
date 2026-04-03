import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { fileURLToPath, pathToFileURL } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Item from './modals/item.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env variables
dotenv.config({ path: path.join(__dirname, '.env') });

async function parseFrontendFile(inputPath, outputPath) {
    let content = fs.readFileSync(inputPath, 'utf-8');
    
    // Replace destructured imports (like react-icons)
    content = content.replace(/import\s+\{\s*([^}]+)\s*\}\s+from\s+['"][^'"]+['"];?/g, (match, p1) => {
        const vars = p1.split(',').map(v => v.trim());
        return vars.map(v => `const ${v} = "${v}";`).join('\n');
    });

    // Replace default imports (local images)
    content = content.replace(/import\s+(\w+)\s+from\s+['"]\.\/([^'"]+)['"];?/g, "const $1 = '$2';");
    
    // Remove any remaining imports
    content = content.replace(/import\s+.*?\s+from\s+['"].*?['"];?/g, '');

    fs.writeFileSync(outputPath, content);
    
    const fileUrl = pathToFileURL(outputPath).href;
    const module = await import(fileUrl);
    return module;
}

function log(msg) {
    fs.appendFileSync('seed.log', msg + '\n');
}

async function seedDatabase() {
    log("Starting Seeding Process...");
    
    // Apply DNS fix for MongoDB Atlas to bypass ISP block
    dns.setServers(['8.8.8.8', '8.8.4.4']);

    // 1. Connect to MongoDB using the project's config
    const { connectDB } = await import('./config/db.js');
    await connectDB();

    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir);
    }
    const assetsDir = path.join(__dirname, '../frontend/src/assets');

    // 2. Parse Files
    const omddPath = path.join(assetsDir, 'OmDD.js');
    const dummyPath = path.join(assetsDir, 'dummydata.js');
    const omddTemp = path.join(__dirname, 'temp_omdd.js');
    const dummyTemp = path.join(__dirname, 'temp_dummy.js');

    try {
        console.log("Parsing frontend data files...");
        const omdd = await parseFrontendFile(omddPath, omddTemp);
        const dummy = await parseFrontendFile(dummyPath, dummyTemp);

        const allItems = [];

        // Extract OmDD.js categories
        if (omdd.dummyMenuData) {
            for (const [category, items] of Object.entries(omdd.dummyMenuData)) {
                items.forEach(item => {
                    allItems.push({ ...item, category });
                });
            }
        }

        // Extract dummydata.js
        if (dummy.cardData) {
            dummy.cardData.forEach(item => allItems.push({ ...item, category: 'Special' }));
        }
        if (dummy.additionalData) {
            dummy.additionalData.forEach(item => allItems.push({ ...item, category: 'Recommended' }));
        }

        console.log(`Found a total of ${allItems.length} items to seed.`);

        let insertedCount = 0;
        let skippedCount = 0;

        // 3. Process and Insert
        for (const rawItem of allItems) {
            // Some names might be " name" or mismatched due to dummy data typos
            const name = (rawItem.name || rawItem.title).trim();
            const description = rawItem.description || "Delicious food item";
            const category = rawItem.category;
            
            // Format price: e.g. "₹40", "13.50", 40
            let priceStr = String(rawItem.price || "0");
            const price = parseFloat(priceStr.replace(/[^\d.]/g, '')) || 0;

            const rating = parseFloat(rawItem.rating) || 0;
            const hearts = parseInt(rawItem.hearts) || 0;
            const imageFilename = rawItem.image || rawItem.img;

            // Handle image copying
            let finalImageUrl = "";
            if (imageFilename && typeof imageFilename === 'string') {
                const sourcePath = path.join(assetsDir, imageFilename);
                if (fs.existsSync(sourcePath)) {
                    const newFilename = `seed_${Date.now()}_${imageFilename}`;
                    const destPath = path.join(uploadsDir, newFilename);
                    fs.copyFileSync(sourcePath, destPath);
                    finalImageUrl = `/uploads/${newFilename}`;
                } else {
                    console.log(`Warning: Image not found for ${name} at ${sourcePath}`);
                }
            }

            // Database insertion
            try {
                const newItem = new Item({
                    name,
                    description,
                    category,
                    price,
                    rating,
                    hearts,
                    total: price * 1,
                    imageUrl: finalImageUrl
                });

                await newItem.save();
                insertedCount++;
                log(`✅ Inserted: ${name}`);
            } catch (err) {
                if (err.code === 11000) {
                    // Duplicate key error
                    skippedCount++;
                    log(`⚠️ Skipped (already exists): ${name}`);
                } else {
                    log(`❌ Error inserting ${name}: ${err.message}`);
                }
            }
        }

        log(`\n🎉 Seeding Complete!`);
        log(`Successfully inserted: ${insertedCount}`);
        log(`Skipped (duplicates): ${skippedCount}`);

    } catch (error) {
        log(`Seeding failed: ${error.stack}`);
    } finally {
        // Cleanup
        if (fs.existsSync(omddTemp)) fs.unlinkSync(omddTemp);
        if (fs.existsSync(dummyTemp)) fs.unlinkSync(dummyTemp);
        
        await mongoose.disconnect();
        log("Disconnected from MongoDB.");
    }
}

fs.writeFileSync('seed.log', 'Starting...\n');
seedDatabase();
