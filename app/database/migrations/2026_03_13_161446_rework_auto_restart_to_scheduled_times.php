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
        Schema::table('auto_restart_settings', function (Blueprint $table) {
            $table->dropColumn(['interval_hours', 'next_restart_at']);
            $table->string('timezone', 50)->default('Asia/Tbilisi');
            $table->integer('discord_reminder_minutes')->default(30);
        });

        Schema::create('scheduled_restart_times', function (Blueprint $table) {
            $table->id();
            $table->string('time', 5); // H:i format like "14:00"
            $table->boolean('enabled')->default(true);
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('scheduled_restart_times');

        Schema::table('auto_restart_settings', function (Blueprint $table) {
            $table->dropColumn(['timezone', 'discord_reminder_minutes']);
            $table->integer('interval_hours')->default(6);
            $table->timestamp('next_restart_at')->nullable();
        });
    }
};
