<?php

namespace Database\Seeders;

use App\Models\ShopBundle;
use App\Models\ShopCategory;
use App\Models\ShopItem;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class ShopSeeder extends Seeder
{
    /**
     * Seed shop categories, items, and bundles.
     */
    public function run(): void
    {
        // ── Categories ───────────────────────────────────────────────────
        $weapons = ShopCategory::query()->updateOrCreate(
            ['slug' => 'weapons'],
            ['name' => 'Weapons', 'description' => 'Melee and ranged weapons', 'icon' => 'sword', 'sort_order' => 1, 'is_active' => true],
        );

        $medical = ShopCategory::query()->updateOrCreate(
            ['slug' => 'medical'],
            ['name' => 'Medical', 'description' => 'First aid and healing supplies', 'icon' => 'heart-pulse', 'sort_order' => 2, 'is_active' => true],
        );

        $food = ShopCategory::query()->updateOrCreate(
            ['slug' => 'food-water'],
            ['name' => 'Food & Water', 'description' => 'Non-perishable food and clean water', 'icon' => 'apple', 'sort_order' => 3, 'is_active' => true],
        );

        $tools = ShopCategory::query()->updateOrCreate(
            ['slug' => 'tools'],
            ['name' => 'Tools', 'description' => 'Construction and survival tools', 'icon' => 'wrench', 'sort_order' => 4, 'is_active' => true],
        );

        $ammo = ShopCategory::query()->updateOrCreate(
            ['slug' => 'ammunition'],
            ['name' => 'Ammunition', 'description' => 'Bullets and shells for firearms', 'icon' => 'crosshair', 'sort_order' => 5, 'is_active' => true],
        );

        $clothing = ShopCategory::query()->updateOrCreate(
            ['slug' => 'clothing-armor'],
            ['name' => 'Clothing & Armor', 'description' => 'Protective gear and clothing', 'icon' => 'shield', 'sort_order' => 6, 'is_active' => true],
        );

        // ── Items ────────────────────────────────────────────────────────

        // Weapons
        $katana = ShopItem::query()->updateOrCreate(
            ['slug' => 'katana'],
            ['name' => 'Katana', 'category_id' => $weapons->id, 'item_type' => 'Base.Katana', 'quantity' => 1, 'price' => 25.00, 'description' => 'A sharp katana blade — swift and deadly.', 'is_featured' => true, 'is_active' => true],
        );

        $baseballBat = ShopItem::query()->updateOrCreate(
            ['slug' => 'baseball-bat'],
            ['name' => 'Baseball Bat', 'category_id' => $weapons->id, 'item_type' => 'Base.BaseballBat', 'quantity' => 1, 'price' => 8.00, 'description' => 'Classic blunt weapon. Reliable and sturdy.', 'is_active' => true],
        );

        $fireAxe = ShopItem::query()->updateOrCreate(
            ['slug' => 'fire-axe'],
            ['name' => 'Fire Axe', 'category_id' => $weapons->id, 'item_type' => 'Base.Axe', 'quantity' => 1, 'price' => 18.00, 'description' => 'Heavy fire axe — doubles as a tool.', 'is_active' => true],
        );

        $shotgun = ShopItem::query()->updateOrCreate(
            ['slug' => 'shotgun'],
            ['name' => 'Shotgun', 'category_id' => $weapons->id, 'item_type' => 'Base.Shotgun', 'quantity' => 1, 'price' => 35.00, 'description' => 'Powerful close-range firearm.', 'is_featured' => true, 'is_active' => true],
        );

        $pistol = ShopItem::query()->updateOrCreate(
            ['slug' => 'pistol'],
            ['name' => 'Pistol', 'category_id' => $weapons->id, 'item_type' => 'Base.Pistol', 'quantity' => 1, 'price' => 22.00, 'description' => 'Standard 9mm handgun.', 'is_active' => true],
        );

        $huntingRifle = ShopItem::query()->updateOrCreate(
            ['slug' => 'hunting-rifle'],
            ['name' => 'Hunting Rifle', 'category_id' => $weapons->id, 'item_type' => 'Base.HuntingRifle', 'quantity' => 1, 'price' => 40.00, 'description' => 'Precision long-range rifle.', 'is_active' => true],
        );

        // Medical
        $firstAidKit = ShopItem::query()->updateOrCreate(
            ['slug' => 'first-aid-kit'],
            ['name' => 'First Aid Kit', 'category_id' => $medical->id, 'item_type' => 'Base.FirstAidKit', 'quantity' => 1, 'price' => 15.00, 'description' => 'Comprehensive first aid supplies.', 'is_featured' => true, 'is_active' => true],
        );

        $bandage = ShopItem::query()->updateOrCreate(
            ['slug' => 'bandage-x5'],
            ['name' => 'Bandages (x5)', 'category_id' => $medical->id, 'item_type' => 'Base.Bandage', 'quantity' => 5, 'price' => 5.00, 'description' => 'Pack of 5 sterile bandages.', 'is_active' => true],
        );

        $antibiotics = ShopItem::query()->updateOrCreate(
            ['slug' => 'antibiotics'],
            ['name' => 'Antibiotics', 'category_id' => $medical->id, 'item_type' => 'Base.Antibiotics', 'quantity' => 1, 'price' => 12.00, 'description' => 'Cure infections before they get worse.', 'is_active' => true],
        );

        $painkillers = ShopItem::query()->updateOrCreate(
            ['slug' => 'painkillers-x3'],
            ['name' => 'Painkillers (x3)', 'category_id' => $medical->id, 'item_type' => 'Base.PillsPainkiller', 'quantity' => 3, 'price' => 6.00, 'description' => 'Reduces pain and improves combat.', 'is_active' => true],
        );

        $alcoholWipes = ShopItem::query()->updateOrCreate(
            ['slug' => 'alcohol-wipes-x5'],
            ['name' => 'Alcohol Wipes (x5)', 'category_id' => $medical->id, 'item_type' => 'Base.AlcoholWipes', 'quantity' => 5, 'price' => 4.00, 'description' => 'Disinfect wounds to prevent infection.', 'is_active' => true],
        );

        // Food & Water
        $cannedFood = ShopItem::query()->updateOrCreate(
            ['slug' => 'canned-food-x5'],
            ['name' => 'Canned Food (x5)', 'category_id' => $food->id, 'item_type' => 'Base.CannedBeans', 'quantity' => 5, 'price' => 8.00, 'description' => 'Non-perishable canned beans.', 'is_active' => true],
        );

        $waterBottle = ShopItem::query()->updateOrCreate(
            ['slug' => 'water-bottle-x3'],
            ['name' => 'Water Bottles (x3)', 'category_id' => $food->id, 'item_type' => 'Base.WaterBottleFull', 'quantity' => 3, 'price' => 5.00, 'description' => 'Clean drinking water.', 'is_active' => true],
        );

        $chips = ShopItem::query()->updateOrCreate(
            ['slug' => 'chips-x5'],
            ['name' => 'Chips (x5)', 'category_id' => $food->id, 'item_type' => 'Base.Crisps', 'quantity' => 5, 'price' => 4.00, 'description' => 'Quick snack — restores a bit of hunger.', 'is_active' => true],
        );

        // Tools
        $hammer = ShopItem::query()->updateOrCreate(
            ['slug' => 'hammer'],
            ['name' => 'Hammer', 'category_id' => $tools->id, 'item_type' => 'Base.Hammer', 'quantity' => 1, 'price' => 6.00, 'description' => 'Essential for barricading and construction.', 'is_active' => true],
        );

        $saw = ShopItem::query()->updateOrCreate(
            ['slug' => 'saw'],
            ['name' => 'Saw', 'category_id' => $tools->id, 'item_type' => 'Base.Saw', 'quantity' => 1, 'price' => 7.00, 'description' => 'Cut planks and disassemble furniture.', 'is_active' => true],
        );

        $screwdriver = ShopItem::query()->updateOrCreate(
            ['slug' => 'screwdriver'],
            ['name' => 'Screwdriver', 'category_id' => $tools->id, 'item_type' => 'Base.Screwdriver', 'quantity' => 1, 'price' => 4.00, 'description' => 'Useful for electrical work and disassembly.', 'is_active' => true],
        );

        $generator = ShopItem::query()->updateOrCreate(
            ['slug' => 'generator'],
            ['name' => 'Generator', 'category_id' => $tools->id, 'item_type' => 'Base.Generator', 'quantity' => 1, 'price' => 50.00, 'description' => 'Portable power generator — keep the lights on.', 'is_featured' => true, 'is_active' => true],
        );

        // Ammunition
        $shotgunShells = ShopItem::query()->updateOrCreate(
            ['slug' => 'shotgun-shells-x20'],
            ['name' => 'Shotgun Shells (x20)', 'category_id' => $ammo->id, 'item_type' => 'Base.ShotgunShells', 'quantity' => 20, 'price' => 12.00, 'description' => '20 rounds of 12-gauge shells.', 'is_active' => true],
        );

        $pistolMag = ShopItem::query()->updateOrCreate(
            ['slug' => '9mm-rounds-x30'],
            ['name' => '9mm Rounds (x30)', 'category_id' => $ammo->id, 'item_type' => 'Base.Bullets9mm', 'quantity' => 30, 'price' => 10.00, 'description' => '30 rounds of 9mm ammunition.', 'is_active' => true],
        );

        $rifleAmmo = ShopItem::query()->updateOrCreate(
            ['slug' => 'rifle-rounds-x20'],
            ['name' => 'Rifle Rounds (x20)', 'category_id' => $ammo->id, 'item_type' => 'Base.308Bullets', 'quantity' => 20, 'price' => 14.00, 'description' => '20 rounds of .308 rifle ammunition.', 'is_active' => true],
        );

        // Clothing & Armor
        $firefighterSuit = ShopItem::query()->updateOrCreate(
            ['slug' => 'firefighter-suit'],
            ['name' => 'Firefighter Suit', 'category_id' => $clothing->id, 'item_type' => 'Base.Hat_FirefighterHelmet', 'quantity' => 1, 'price' => 30.00, 'description' => 'Full firefighter gear — excellent bite protection.', 'is_featured' => true, 'is_active' => true],
        );

        $leatherJacket = ShopItem::query()->updateOrCreate(
            ['slug' => 'leather-jacket'],
            ['name' => 'Leather Jacket', 'category_id' => $clothing->id, 'item_type' => 'Base.Jacket_LeatherBlack', 'quantity' => 1, 'price' => 15.00, 'description' => 'Decent scratch protection with style.', 'is_active' => true],
        );

        $militaryBoots = ShopItem::query()->updateOrCreate(
            ['slug' => 'military-boots'],
            ['name' => 'Military Boots', 'category_id' => $clothing->id, 'item_type' => 'Base.Shoes_ArmyBoots', 'quantity' => 1, 'price' => 10.00, 'description' => 'Durable boots — reduces trip chance.', 'is_active' => true],
        );

        // ── Bundles ──────────────────────────────────────────────────────

        $starterBundle = ShopBundle::query()->updateOrCreate(
            ['slug' => 'starter-pack'],
            ['name' => 'Starter Pack', 'description' => 'Everything a fresh survivor needs to get started.', 'price' => 20.00, 'is_featured' => true, 'is_active' => true],
        );
        $this->syncBundleItems($starterBundle, [
            $baseballBat->id => 1,
            $bandage->id => 1,
            $cannedFood->id => 1,
            $waterBottle->id => 1,
            $hammer->id => 1,
        ]);

        $combatBundle = ShopBundle::query()->updateOrCreate(
            ['slug' => 'combat-loadout'],
            ['name' => 'Combat Loadout', 'description' => 'Armed and ready — full weapon kit with ammo.', 'price' => 65.00, 'is_featured' => true, 'is_active' => true],
        );
        $this->syncBundleItems($combatBundle, [
            $shotgun->id => 1,
            $pistol->id => 1,
            $shotgunShells->id => 1,
            $pistolMag->id => 1,
        ]);

        $medicBundle = ShopBundle::query()->updateOrCreate(
            ['slug' => 'medic-kit'],
            ['name' => 'Medic Kit', 'description' => 'Full medical supplies — be your group\'s lifesaver.', 'price' => 30.00, 'is_active' => true],
        );
        $this->syncBundleItems($medicBundle, [
            $firstAidKit->id => 1,
            $bandage->id => 2,
            $antibiotics->id => 1,
            $painkillers->id => 1,
            $alcoholWipes->id => 1,
        ]);

        $builderBundle = ShopBundle::query()->updateOrCreate(
            ['slug' => 'builder-essentials'],
            ['name' => 'Builder Essentials', 'description' => 'All the tools needed to fortify your base.', 'price' => 15.00, 'is_active' => true],
        );
        $this->syncBundleItems($builderBundle, [
            $hammer->id => 1,
            $saw->id => 1,
            $screwdriver->id => 1,
        ]);

        $doomsday = ShopBundle::query()->updateOrCreate(
            ['slug' => 'doomsday-package'],
            ['name' => 'Doomsday Package', 'description' => 'The ultimate survival bundle — weapons, armor, meds, tools, and food.', 'price' => 150.00, 'is_featured' => true, 'is_active' => true],
        );
        $this->syncBundleItems($doomsday, [
            $katana->id => 1,
            $shotgun->id => 1,
            $shotgunShells->id => 1,
            $firstAidKit->id => 1,
            $antibiotics->id => 1,
            $generator->id => 1,
            $firefighterSuit->id => 1,
            $cannedFood->id => 2,
            $waterBottle->id => 2,
        ]);
    }

    /**
     * Sync bundle items with UUID-based pivot table.
     *
     * @param  array<string, int>  $itemQuantities  item_id => quantity
     */
    private function syncBundleItems(ShopBundle $bundle, array $itemQuantities): void
    {
        DB::table('shop_bundle_items')->where('bundle_id', $bundle->id)->delete();

        $rows = [];
        foreach ($itemQuantities as $itemId => $quantity) {
            $rows[] = [
                'id' => Str::uuid()->toString(),
                'bundle_id' => $bundle->id,
                'shop_item_id' => $itemId,
                'quantity' => $quantity,
            ];
        }

        DB::table('shop_bundle_items')->insert($rows);
    }
}
