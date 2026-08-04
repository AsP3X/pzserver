<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('scheduled_broadcasts', function (Blueprint $table) {
            $table->id();
            $table->string('message');
            /** 'interval' repeats every N minutes; 'daily' fires at a wall-clock time. */
            $table->string('cadence')->default('interval');
            $table->unsignedSmallInteger('interval_minutes')->nullable();
            /** HH:MM in the configured timezone, for the daily cadence. */
            $table->string('time', 5)->nullable();
            $table->string('timezone')->default('Asia/Tbilisi');
            $table->boolean('enabled')->default(true);
            $table->timestamp('last_sent_at')->nullable();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('scheduled_broadcasts');
    }
};
