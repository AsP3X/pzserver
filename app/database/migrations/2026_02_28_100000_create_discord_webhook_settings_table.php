<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('discord_webhook_settings', function (Blueprint $table) {
            $table->id();
            $table->text('webhook_url')->nullable();
            $table->boolean('enabled')->default(false);
            $table->jsonb('enabled_events')->default('[]');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('discord_webhook_settings');
    }
};
