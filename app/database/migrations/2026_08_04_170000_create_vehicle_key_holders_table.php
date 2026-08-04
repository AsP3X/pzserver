<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * The mod can only see keys in a loaded inventory, so ownership would
     * disappear the moment a player logged off. This remembers who was last
     * seen holding each vehicle's key.
     */
    public function up(): void
    {
        Schema::create('vehicle_key_holders', function (Blueprint $table) {
            $table->id();
            $table->unsignedInteger('vehicle_id');
            $table->unsignedInteger('key_id');
            $table->string('username');
            $table->timestamp('last_seen_at');
            $table->timestamps();

            /** One row per person per vehicle; a key can be copied, a pairing cannot repeat. */
            $table->unique(['vehicle_id', 'username']);
            $table->index('vehicle_id');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('vehicle_key_holders');
    }
};
